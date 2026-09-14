/** Fresh, separately labelled delivery validation; paid dispatch requires an explicit source pin. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { streamSimple, type FetchImpl } from '@oh-my-pi/pi-ai';
import { coworkFetch } from '@oh-my-pi/pi-ai/providers/cowork-fetch';
import type { StreamFn } from '@oh-my-pi/pi-agent-core';
import { main } from '../../src/cli/main';
import { createCliRuntime } from '../../src/cli/runtime';
import { finishProcess } from '../../src/cli/exit';
import { loadConfig, saveConfig } from '../../src/core/config';
import { initHome } from '../../src/core/home';
import { kilnHome, writeAtomic } from '../../src/core/paths';
import { RunRecord } from '../../src/core/record';
import { runPaths, readStatus } from '../../src/core/run';
import { RunControl, withRunControl } from '../../src/core/run-control';
import { modelCostUsd } from '../../src/providers/models';
import { requestBody } from './runtime-pilot';
import { reservation, settleReservation } from './delivery-recovery-pilot';
import { loadWorkflowPlan, compileWorkflow } from '../../src/workflow/plan';
import type { RunPaths } from '../../src/core/run';

export const DELIVERY_CAP_USD = 17.50;
export function assertDirectWorkflow(run: RunPaths) {
  const plan = loadWorkflowPlan(run);
  if (!plan || plan.strategy?.mode !== 'direct') throw new Error('Validation requires persisted direct adaptive workflow before dispatch');
  const execution = compileWorkflow(plan,{through:'reflect',autonomous:true});
  if (execution.phases.some(p => p === 'discover' || p === 'ideate')) throw new Error('Validation must skip discovery and competitive ideation');
  return {plan,execution};
}

export const DELIVERY_SEED = 'Create and ship a dependency-free Python CLI named slugify.py that converts a supplied UTF-8 string to a lowercase ASCII hyphenated slug. Normalize accents with the standard library, collapse whitespace and punctuation, trim boundary hyphens, and reject an empty resulting slug with a nonzero exit status. Include executable unittest coverage for accents, punctuation, and empty input, plus a concise README with usage. This is a small local implementation task; no external research, hosted service, installation, or deployment is needed. Use the current directory only for the generated project; do not modify unrelated files. Finish when the CLI and tests pass.';
export function outputAllowance(tools: readonly {name:string}[] = []): number {
  return tools.some(t => ['critique','audit'].includes(t.name)) ? 32768 : 16384;
}
/** Config's computed budget methods are runtime helpers, not snapshot data. */
export function serializableConfig(cfg: ReturnType<typeof loadConfig>): Record<string, any> {
  return JSON.parse(JSON.stringify(cfg));
}
export function sourceHash(root: string): string {
  const walk = (dir:string):string[] => readdirSync(join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.isFile()?[join(dir,e.name)]:[]);
  const paths=[...walk('src'),...walk('bin'),...walk('prompts'),'package.json','bun.lock'].filter(p=>existsSync(join(root,p))).sort();
  const hash=createHash('sha256');
  for(const p of paths) hash.update(p).update('\0').update(readFileSync(join(root,p))).update('\0');
  return hash.digest('hex');
}
async function run() {
  const opt=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
  if(!Bun.argv.includes('--confirm-spend') || !opt('--expected-source')) throw new Error('Require --confirm-spend --expected-source HASH after parent green');
  const root=resolve(import.meta.dir,'../..'), before=sourceHash(root);
  if(before!==opt('--expected-source')) throw new Error('Production source differs from approved pin; no dispatch');
  const home=mkdtempSync(join(tmpdir(),'kiln-delivery-validation-'));chmodSync(home,0o700);
  initHome(home,{plugAndPlay:true});
  const authHome=resolve(kilnHome()), cfg=loadConfig(authHome);
  const originalConfig=serializableConfig(cfg);
  cfg.budgets.usd=25;cfg.budgets.wallSeconds=1500;cfg.routing={mode:'adaptive'};cfg.autonomous=true;cfg.provider.fallbacks='off';
  saveConfig(home,cfg);
  const runtime=await createCliRuntime(authHome,cfg,{runtimeEffort:{enabled:false}});
  const run=runPaths(home,'fresh-delivery');
  const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
  const freeze={label:'Fresh fixed-core delivery validation; not a rescore of either earlier attempt',home,sourceCoreHash:before,scriptHash:hash(readFileSync(import.meta.filename)),seedHash:hash(DELIVERY_SEED),originalConfig,config:cfg,configDelta:{'budgets.usd':25,'budgets.wallSeconds':1500,routing:'adaptive',autonomous:true,'provider.fallbacks':'off'},capUsd:DELIVERY_CAP_USD,maxTokens:{critique:32768,audit:32768,other:16384},wallSeconds:1500,startedAt:new Date().toISOString()};
  writeAtomic(join(home,'validation-freeze.json'),JSON.stringify(freeze,null,2),{mode:0o600});
  const control=new RunControl(),pending=new Set<Promise<unknown>>();
  let spent=0,charged=0,requests=0;const calls:any[]=[];
  const ledger=()=>writeAtomic(join(home,'provider-ledger.json'),JSON.stringify({spentUsd:spent,chargedUsd:charged,requests,calls},null,2),{mode:0o600});
  const capped:StreamFn=(model,context,options)=>{
    control.signal.throwIfAborted();
    if(model.provider!=='anthropic') throw new Error('Unsupported output-cap transport; fail closed before dispatch');
    const maxTokens=outputAllowance(context.tools), request=++requests;
    let reserve=reservation(model.cost,Buffer.byteLength(JSON.stringify(context)),maxTokens),dispatched=false;
    if(charged+reserve>DELIVERY_CAP_USD){control.cancel('Delivery reservation cap exhausted');throw control.signal.reason;}
    charged+=reserve;
    const entry:any={request,model:`${model.provider}/${model.id}`,maxTokens,reserveUsd:reserve,dispatched:false,startedAt:new Date().toISOString()};calls.push(entry);ledger();
    const guardedFetch:FetchImpl=async(url,init)=>{
      if(dispatched)throw new Error('Transport retry disabled');
      control.signal.throwIfAborted();
      const body=await requestBody(url,init),wire=JSON.parse(body);
      if(wire.model!==model.id || wire.max_tokens!==maxTokens)throw new Error('Provider model/output cap contract mismatch');
      const exact=reservation(model.cost,Buffer.byteLength(body),maxTokens);
      if(charged-reserve+exact>DELIVERY_CAP_USD){control.cancel('Exact wire reservation exceeds cap');throw control.signal.reason;}
      charged+=exact-reserve;reserve=exact;Object.assign(entry,{reserveUsd:exact,dispatched:true});dispatched=true;ledger();
      return coworkFetch(url,init);
    };
    const {fallbacks:_fallbacks,...rest}=options??{};
    const signal=options?.signal?AbortSignal.any([options.signal,control.signal]):control.signal;
    const stream=streamSimple(model,context,{...rest,maxTokens,fetch:guardedFetch,signal,acceptEmptyResponse:true,preferWebsockets:false});
    const done=stream.result().then(message=>{
      const actual=modelCostUsd(model,message.usage),keep=dispatched?settleReservation(reserve,actual,message.stopReason):0;
      charged+=keep-reserve;if(Number.isFinite(actual)&&actual>=0)spent+=actual;
      Object.assign(entry,{costUsd:actual,usage:message.usage,stopReason:message.stopReason,chargedUsd:keep,finishedAt:new Date().toISOString()});ledger();
      console.log(JSON.stringify({request,model:entry.model,maxTokens,spentUsd:spent,chargedUsd:charged,stopReason:message.stopReason}));
      if(charged>DELIVERY_CAP_USD)control.cancel('Delivery accounting cap reached');
    },error=>{entry.error=String(error);if(!dispatched)charged-=reserve;ledger();control.cancel('Provider failure; unknown usage retained');});
    pending.add(done);void done.finally(()=>pending.delete(done));return stream;
  };
  let code=1;const output:string[]=[],errors:string[]=[];
  const timer=setTimeout(()=>control.cancel('Delivery validation 25-minute wall cap'),1500000);
  console.log(JSON.stringify({deliveryValidationStarted:home,sourceCoreHash:before,capUsd:DELIVERY_CAP_USD,targetUsd:25,effort:cfg.effort}));
  try{code=await withRunControl(control,()=>main(['run','new',DELIVERY_SEED,'--id','fresh-delivery','--home',home,'--through','reflect','--yes','--autonomous','--json'],{write:t=>output.push(t),error:t=>errors.push(t)},{apiKeyFor:runtime.apiKeyFor,fetchUsage:runtime.fetchUsage,streamFn:capped,onRun:active=>{
    const validated=assertDirectWorkflow(active);
    const routing=JSON.parse(readFileSync(join(active.dir,'routing.json'),'utf8'));
    writeAtomic(join(home,'effective-routing.json'),JSON.stringify({validated,routing},null,2),{mode:0o600});
    console.log(JSON.stringify({adaptivePreflight:'passed',phases:validated.execution.phases,roles:routing.roles,effectiveEffort:routing.effectiveEffort}));
  }}));}
  catch(e){errors.push(String(e));}
  finally{clearTimeout(timer);await Promise.allSettled([...pending]);}
  const after=sourceHash(root),status=existsSync(run.status)?readStatus(run):null,recorded=existsSync(run.record)?new RunRecord(run.record).costUsd():0;
  const report={label:freeze.label,home,code,status,providerSpentUsd:spent,chargedUsd:charged,recordedCostUsd:recorded,requests,sourceCoreHash:before,finalSourceCoreHash:after,coreUnchanged:before===after,errors,output,finishedAt:new Date().toISOString()};
  writeAtomic(join(home,'validation-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({...report,output:undefined,errors:undefined}));await finishProcess(code);
}
if(import.meta.main)await run();
