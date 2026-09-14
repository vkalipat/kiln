/** Separately labelled, one-shot resume diagnostic. Never a baseline rescore. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { streamSimple, type FetchImpl } from '@oh-my-pi/pi-ai';
import { coworkFetch } from '@oh-my-pi/pi-ai/providers/cowork-fetch';
import type { StreamFn } from '@oh-my-pi/pi-agent-core';
import { main } from '../../src/cli/main';
import { createCliRuntime } from '../../src/cli/runtime';
import { finishProcess } from '../../src/cli/exit';
import { loadConfig } from '../../src/core/config';
import { kilnHome, writeAtomic } from '../../src/core/paths';
import { RunRecord } from '../../src/core/record';
import { runPaths, readStatus } from '../../src/core/run';
import { RunControl, withRunControl } from '../../src/core/run-control';
import { applyFrozenRouting } from '../../src/workflow/routing';
import { modelCostUsd } from '../../src/providers/models';
import { requestBody } from './runtime-pilot';

export function reservation(cost: any, bytes: number, output = 6144): number {
  const tiers = [cost, ...(cost.longContext ? [cost.longContext] : [])];
  const inputRate = Math.max(...tiers.flatMap(c => [c.input, c.cacheRead, c.cacheWrite, c.input * 2]));
  return ((bytes + 8192) * inputRate + output * Math.max(...tiers.map(c => c.output))) / 1e6;
}
export function settleReservation(reserve: number, actual: number, stop: string): number {
  return !Number.isFinite(actual) || actual < 0 || ['error', 'aborted'].includes(stop) ? Math.max(reserve, Number.isFinite(actual) ? actual : 0) : actual;
}
function coreHash(root: string): string {
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir,e.name)) : e.isFile() ? [join(dir,e.name)] : []);
  const paths = [...walk('src'), ...walk('bin'), ...walk('prompts'), 'package.json', 'bun.lock'].filter(p => existsSync(join(root,p))).sort();
  const hash = createHash('sha256');
  for (const p of paths) hash.update(p).update('\0').update(readFileSync(join(root,p))).update('\0');
  return hash.digest('hex');
}
async function run() {
  if (!Bun.argv.includes('--confirm-spend')) throw new Error('Explicit paid recovery requires --confirm-spend');
  const home = resolve(Bun.argv[Bun.argv.indexOf('--home') + 1]!);
  const authHome = resolve(kilnHome()), root = resolve(import.meta.dir,'../..');
  if (home === authHome || !home.includes('kiln-live-delivery-')) throw new Error('Expected isolated existing delivery home');
  const marker = join(home,'recovery-freeze.json');
  if (existsSync(marker)) throw new Error('Recovery already started; refusing duplicate dispatch or reset of reservations');
  const run = runPaths(home,'live-delivery'), initial = readStatus(run);
  if (initial.state !== 'stopped' || initial.phase !== 'form') throw new Error('Expected stopped formation baseline');
  const originalRaw = readFileSync(join(home,'config.json'),'utf8'), original = JSON.parse(originalRaw);
  if (original.budgets.usd !== 8) throw new Error('Expected original isolated target eight dollars');
  const initialCost = new RunRecord(run.record).costUsd();
  if (Math.abs(initialCost - 2.00012) > 0.00001) throw new Error('Initial recorded cost changed');
  const beforeHash = coreHash(root);
  if (beforeHash !== '7ef356d324bfc8567abd2c2aa0ae170d5257ee58c44b43c9654911500f50ecdc') throw new Error('Frozen production source hash changed');
  const effective = applyFrozenRouting(loadConfig(home),run);
  const runtime = await createCliRuntime(authHome,effective,{runtimeEffort:{enabled:false}});
  const selected = Object.fromEntries(Object.keys(effective.roles).map(role => [role,runtime.models(role as any).ref]));
  copyFileSync(join(home,'validation-report.json'),join(home,'baseline-validation-report.json'),constants.COPYFILE_EXCL);
  copyFileSync(join(home,'config.json'),join(home,'baseline-config.json'),constants.COPYFILE_EXCL);
  writeAtomic(marker,JSON.stringify({label:'Recovery diagnostic; original attempt remains budget-censored',initialCost,initialStatus:initial,sourceCoreHash:beforeHash,selected,capUsd:8,additionalAllowanceUsd:8-initialCost,isolatedTargetUsd:25,maxTokens:6144,wallSeconds:1500,startedAt:new Date().toISOString()},null,2),{mode:0o600});
  original.budgets.usd = 25;
  writeAtomic(join(home,'config.json'),JSON.stringify(original,null,2)+'\n',{mode:0o600});
  const control = new RunControl(), pending = new Set<Promise<unknown>>();
  let spent = initialCost, charged = initialCost, requests = 0;
  const calls: any[] = [];
  const ledger = () => writeAtomic(join(home,'recovery-provider-ledger.json'),JSON.stringify({spentUsd:spent,chargedUsd:charged,requests,calls},null,2),{mode:0o600});
  const capped: StreamFn = (model,context,options) => {
    control.signal.throwIfAborted();
    if (model.provider !== 'anthropic') throw new Error('Unexpected provider cannot enforce output cap; fail closed');
    let reserve = reservation(model.cost,Buffer.byteLength(JSON.stringify(context))), dispatched = false;
    if (charged + reserve > 8) { control.cancel('Recovery reservation budget exhausted'); throw control.signal.reason; }
    charged += reserve;
    const entry:any = {request:++requests,model:`${model.provider}/${model.id}`,reserveUsd:reserve,startedAt:new Date().toISOString(),dispatched:false}; calls.push(entry); ledger();
    const guardedFetch: FetchImpl = async(url,init) => {
      if (dispatched) throw new Error('Recovery transport retry disabled');
      control.signal.throwIfAborted();
      const body = await requestBody(url,init), wire = JSON.parse(body);
      if (wire.max_tokens !== 6144 || wire.model !== model.id) throw new Error('Recovery model/output isolation failed');
      const exact = reservation(model.cost,Buffer.byteLength(body));
      if (charged - reserve + exact > 8) { control.cancel('Exact wire reservation exceeds recovery cap'); throw control.signal.reason; }
      charged += exact - reserve; reserve = exact; entry.reserveUsd = exact; entry.dispatched = true; dispatched = true; ledger();
      return coworkFetch(url,init);
    };
    const {fallbacks: _fallbacks,...rest} = options ?? {};
    const signal = options?.signal ? AbortSignal.any([options.signal,control.signal]) : control.signal;
    const stream = streamSimple(model,context,{...rest,maxTokens:6144,fetch:guardedFetch,signal,acceptEmptyResponse:true,preferWebsockets:false});
    const done = stream.result().then(message => {
      const actual = modelCostUsd(model,message.usage);
      const keep = dispatched ? settleReservation(reserve,actual,message.stopReason) : 0;
      charged += keep - reserve;
      if (Number.isFinite(actual) && actual >= 0) spent += actual;
      Object.assign(entry,{costUsd:actual,stopReason:message.stopReason,chargedUsd:keep,finishedAt:new Date().toISOString()}); ledger();
      console.log(JSON.stringify({recoveryRequest:requests,spentUsd:spent,chargedUsd:charged,stopReason:message.stopReason}));
      if (charged > 8) control.cancel('Recovery cap reached');
    },error => { entry.error=String(error); if(!dispatched) charged-=reserve; ledger(); control.cancel('Provider failure; unknown usage retained'); });
    pending.add(done); void done.finally(()=>pending.delete(done));
    return stream;
  };
  const timer = setTimeout(()=>control.cancel('Recovery 25-minute wall cap'),1500000);
  let code=1; const errors:string[]=[], output:string[]=[];
  console.log(JSON.stringify({recoveryStarted:home,initialCost,capUsd:8,selected}));
  try {
    code=await withRunControl(control,()=>main(['run','resume','live-delivery','--home',home,'--through','reflect','--yes','--autonomous','--json'],{write:t=>output.push(t),error:t=>errors.push(t)},{apiKeyFor:runtime.apiKeyFor,fetchUsage:runtime.fetchUsage,streamFn:capped,runtimeEffort:{enabled:false}}));
  } catch(e) { errors.push(String(e)); }
  finally {clearTimeout(timer);await Promise.allSettled([...pending]);}
  const afterHash=coreHash(root), status=readStatus(run), recorded=new RunRecord(run.record).costUsd();
  const report={label:'Separate recovery diagnostic; original baseline remains censored',home,code,status,initialCost,providerSpentUsd:spent,chargedUsd:charged,recordedCostUsd:recorded,requests,sourceCoreHash:beforeHash,finalSourceCoreHash:afterHash,coreUnchanged:beforeHash===afterHash,errors,output,finishedAt:new Date().toISOString()};
  writeAtomic(join(home,'recovery-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({...report,output:undefined,errors:undefined}));
  await finishProcess(code);
}
if(import.meta.main) await run();
