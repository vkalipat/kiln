/** Explicit, single-use recovery diagnostic; existing worker and original receipts stay intact. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, chmodSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { main } from "../../src/cli/main";
import { createCliRuntime } from "../../src/cli/runtime";
import { finishProcess } from "../../src/cli/exit";
import { loadConfig } from "../../src/core/config";
import { runPaths, readStatus, type RunPaths } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { acquireRunLock, readRunLock } from "../../src/core/lock";
import { elapsedByPhase } from "../../src/core/budget";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { RunControl, withRunControl } from "../../src/core/run-control";
import { applyFrozenRouting, loadFrozenRouting } from "../../src/workflow/routing";
import { routeResume } from "../../src/cli/commands/run-routing";
import { runDiscover, cachedDiscoverySynthesisWallMs } from "../../src/phases/discover";
import { runIdeate } from "../../src/phases/ideate";
import { runCheckpoint } from "../../src/phases/checkpoint";
import { computeMetrics } from "../../src/ideation/metrics";
import { modelCostUsd } from "../../src/providers/models";
import { contextInputHash } from "../../src/brain/telemetry";
import { FifoBudget, QualificationBudgetExhausted, claimExecution, completionEvidence, assertNativePlan, type BudgetTicket } from "./adaptive-ideation-validation";
import { outputLimit } from "./ideation-validation";
import { reservation } from "./delivery-recovery-pilot";
import { requestBody } from "./runtime-pilot";

const ROOT=resolve(import.meta.dir,"../.."),ID="native-adaptive-ideation";
export const ORIGINAL_GUARD_USD=14,ORIGINAL_WALL_SECONDS=1500,ORIGINAL_REQUEST_LIMIT=300;
const EXPECTED_RECORD_SHA="a1f0bb68dc673893a819b2121a81916ba2b376e0e7534de058ec6bf0668b03b8";
const EXPECTED_PRIOR_CHARGED=5.673911;
const HELPERS=["adaptive-ideation-recovery.ts","adaptive-ideation-validation.ts","ideation-validation.ts","runtime-pilot.ts","delivery-recovery-pilot.ts"];
const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const json=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
const save=(path:string,value:unknown)=>writeAtomic(path,JSON.stringify(value,null,2)+"\n",{mode:0o600});
const opt=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
function files(root:string,sub=""):string[]{return readdirSync(join(root,sub),{withFileTypes:true}).flatMap(e=>{
  const p=join(sub,e.name);if(e.isSymbolicLink())throw new Error(`Archive/snapshot symlink rejected: ${p}`);
  if(e.isDirectory())return files(root,p);return e.isFile()?[p]:[];
});}
function treeHash(root:string,paths:string[]){const h=createHash("sha256");for(const p of [...paths].sort())h.update(p).update("\0").update(readFileSync(join(root,p))).update("\0");return h.digest("hex");}
function sourceHash(root=ROOT){return treeHash(root,[...files(root,"src"),...files(root,"bin"),...files(root,"prompts"),"package.json","bun.lock"]);}
const helperHashes=()=>Object.fromEntries(HELPERS.map(p=>[p,sha(readFileSync(join(import.meta.dir,p)))]));
export function recoveryLimits(prior:{chargedUsd:number;activeWallSeconds:number;requests:number}){
  if(!Number.isFinite(prior.chargedUsd)||prior.chargedUsd<0||prior.chargedUsd>=ORIGINAL_GUARD_USD||!Number.isFinite(prior.activeWallSeconds)||prior.activeWallSeconds<0||prior.activeWallSeconds>=ORIGINAL_WALL_SECONDS||!Number.isSafeInteger(prior.requests)||prior.requests<0||prior.requests>=ORIGINAL_REQUEST_LIMIT)throw new Error("No valid remaining logical-experiment allowance");
  return {incrementalChargedCapUsd:ORIGINAL_GUARD_USD-prior.chargedUsd,remainingWallMs:Math.floor((ORIGINAL_WALL_SECONDS-prior.activeWallSeconds)*1000),remainingRequests:ORIGINAL_REQUEST_LIMIT-prior.requests};
}
export function preservedPrefix(before:Buffer,after:Buffer){return after.length>=before.length&&after.subarray(0,before.length).equals(before);}
export function immutableChanges(root:string,manifest:Record<string,string>){return Object.entries(manifest).flatMap(([p,digest])=>!existsSync(join(root,p))||sha(readFileSync(join(root,p)))!==digest?[p]:[]);}
function hashes(root:string,paths:string[]){return Object.fromEntries(paths.map(p=>[p,sha(readFileSync(join(root,p)))]));}
function ownedLock(run:RunPaths){const lock=readRunLock(run);if(lock?.pid!==process.pid)throw new Error("Recovery snapshot requires native run-lock ownership");return {pid:lock.pid,tokenHash:sha(lock.token??"legacy")};}
export { ownedLock as assertRecoveryLock };
export function assertRecoveryAccounting(protocol:any,baseline:{chargedUsd:number;recordedUsd:number;observedUsd:number;requests:number;historySha:string}){
  if(protocol.baselineChargedUsd!==baseline.chargedUsd||protocol.baselineRecordedUsd!==baseline.recordedUsd||protocol.baselineObservedUsd!==baseline.observedUsd||protocol.baselineRequests!==baseline.requests||protocol.baselineHistory?.sha256!==baseline.historySha)throw new Error("Recovery baseline accounting or history cannot be reset");
}
function history(run:RunPaths){const bytes=readFileSync(run.record),events=new RunRecord(run.record).read(),open=new Set<string>();for(const e of events){if(e.t==="phase.start")open.add(e.phase);if(e.t==="phase.end")open.delete(e.phase);}return {bytes:bytes.length,sha256:sha(bytes),lastSequence:events.at(-1)?.seq??0,modelCalls:events.filter(e=>e.t==="model.call").length,costUsd:new RunRecord(run.record).costUsd(),activeWallSeconds:Object.values(elapsedByPhase(events,Date.now())).reduce((n,v)=>n+(v??0),0),openPhases:[...open]};}
const USAGE_FIELDS=["input","output","cacheRead","cacheWrite"] as const;
const zeroUsage=(u:any)=>!!u&&USAGE_FIELDS.every(k=>u[k]===0);
/** Match journaled calls by model/input hash, not by the number of created streams. */
export function reconcileRecordedCalls(attempts:any[],rows:any[],controllerCancelled=false){
  const unused=new Set(attempts.map((_,i)=>i)),errors:string[]=[],matches:any[]=[];
  for(const row of rows){
    const ref=`${row.provider}/${row.model}`;
    // Native cancellation can normalize a completed provider stop after its usage settled.
    // Admit only that label change; identity, exact usage/cost and exposure remain binding.
    const cancelledStop=(a:any)=>controllerCancelled&&a.dispatched===true&&a.error===undefined&&a.stop==="stop"&&row.stopReason==="aborted"
      &&Number.isFinite(a.costUsd)&&a.costUsd===row.costUsd
      &&USAGE_FIELDS.every(k=>typeof a.usage?.[k]==="number"&&Number.isFinite(a.usage[k])&&a.usage[k]>=0&&a.usage[k]===row.usage?.[k]);
    const index=[...unused].find(i=>attempts[i].model===ref&&attempts[i].inputHash===row.inputHash&&(attempts[i].stop===row.stopReason||cancelledStop(attempts[i])));
    if(index===undefined){errors.push(`Journal call ${row.seq} has no matching owned model/input/stop receipt`);continue;}
    unused.delete(index);const a=attempts[index];
    if(!a.dispatched&&(!zeroUsage(row.usage)||row.costUsd!==0))errors.push(`Undispatched attempt ${a.request} has nonzero canonical usage`);
    if(typeof row.costUsd!=="number"||!Number.isFinite(row.costUsd)||row.costUsd<0||row.costUsd>(a.chargedUsd??0)+1e-9)errors.push(`Canonical cost for attempt ${a.request} exceeds its retained exposure`);
    if(a.dispatched&&!zeroUsage(a.usage)&&a.usage){
      if(USAGE_FIELDS.some(k=>a.usage[k]!==row.usage?.[k])||Math.abs((a.costUsd??0)-row.costUsd)>1e-9)errors.push(`Canonical usage differs from settled owned attempt ${a.request}`);
    }
    matches.push({request:a.request,journalSequence:row.seq,dispatched:a.dispatched,canonicalCostUsd:row.costUsd,observedCostUsd:a.costUsd??null});
  }
  const unrecorded:any[]=[];
  for(const index of unused){const a=attempts[index];
    const unpaid=!a.dispatched&&(a.chargedUsd??0)===0&&(a.costUsd??0)===0&&(a.stop==="aborted"||a.stop==="error"||typeof a.error==="string");
    const retainedUnknown=a.dispatched&&(a.chargedUsd??0)>0&&(a.chargedUsd??0)>=(a.reserveUsd??Infinity)&&((a.stop==="aborted"&&zeroUsage(a.usage))||typeof a.error==="string");
    if(!unpaid&&!retainedUnknown)errors.push(`Owned attempt ${a.request} is missing its required canonical call`);
    unrecorded.push({request:a.request,dispatched:a.dispatched,stop:a.stop,chargedUsd:a.chargedUsd??0,reason:unpaid?"undispatched zero-usage terminal":retainedUnknown?"dispatched terminal with unknown usage fully reserved":"unexplained missing journal call"});
  }
  return {ok:errors.length===0,errors,createdStreams:attempts.length,dispatchedRequests:attempts.filter(a=>a.dispatched).length,recordedCalls:rows.length,undispatchedAttempts:attempts.filter(a=>!a.dispatched).map(a=>({request:a.request,stop:a.stop,error:a.error,chargedUsd:a.chargedUsd??0})),matches,unrecorded};
}
/** Permit only the native, bounded cancellation closure after a receipt held under the run lock. */
export function verifyFinalJournal(after:Buffer,receipt:any,controllerCancelled:boolean,status:any,nowMs=Date.now()){
  const h=receipt?.history;if(!h||!Number.isSafeInteger(h.bytes)||h.bytes<0||after.length<h.bytes||sha(after.subarray(0,h.bytes))!==h.sha256)return {ok:false,kind:"receipt-prefix-mismatch"};
  if(after.length===h.bytes)return {ok:true,kind:"exact-receipt"};
  const phases=h.openPhases;
  if(!controllerCancelled||status?.state!=="paused"||status.pausedReason!=="user_cancelled"||!Array.isArray(phases)||phases.length>6||new Set(phases).size!==phases.length||phases.some((p:any)=>!["frame","discover","ideate","form","build","reflect"].includes(p)))return {ok:false,kind:"unexpected-post-receipt-events"};
  const suffix=after.subarray(h.bytes).toString("utf8");if(!suffix.endsWith("\n"))return {ok:false,kind:"torn-cancellation-suffix"};
  let tail:any[];try{const lines=suffix.slice(0,-1).split("\n");if(lines.some(s=>s===""))throw new Error();tail=lines.map(s=>JSON.parse(s));}catch{return {ok:false,kind:"malformed-cancellation-suffix"};}
  const expected=[...phases.map((phase:string)=>({t:"phase.end",phase,outcome:"cancelled"})),{t:"note",text:"operator cancelled the active step; resume from the saved boundary"}];
  let previous=Date.parse(receipt.at);if(!Number.isFinite(previous)||tail.length!==expected.length)return {ok:false,kind:"unexpected-cancellation-count"};
  for(let i=0;i<tail.length;i++){const event=tail[i],want=expected[i]!,time=Date.parse(event.ts);
    if(event.seq!==h.lastSequence+i+1||typeof event.ts!=="string"||!Number.isFinite(time)||time<previous||time>nowMs||new Date(time).toISOString()!==event.ts||JSON.stringify(Object.keys(event).sort())!==JSON.stringify([...Object.keys(want),"seq","ts"].sort())||Object.entries(want).some(([key,value])=>event[key]!==value))return {ok:false,kind:"unexpected-cancellation-event"};previous=time;
  }
  if(Math.abs((status.usdSpent??NaN)-h.costUsd)>1e-9||!Number.isFinite(status.usdSpent))return {ok:false,kind:"cancellation-cost-drift"};
  return {ok:true,kind:"native-controller-cancellation-suffix",events:tail.length};
}
function checkpoints(run:RunPaths){return readdirSync(run.discoveryDir).filter(f=>f.endsWith(".md")).sort().map(file=>{
  const text=readFileSync(join(run.discoveryDir,file),"utf8"),line=text.split("\n")[0]??"",prefix="<!-- kiln-scout-v1:";
  if(!line.startsWith(prefix)||!line.endsWith(" -->"))throw new Error("Invalid saved scout checkpoint");
  const metadata=JSON.parse(Buffer.from(line.slice(prefix.length,-4),"base64url").toString("utf8"));
  const question=text.match(/\n# Question\n([\s\S]*?)\n\n# Findings\n/)?.[1],brief=readFileSync(run.brief,"utf8");
  if(!question||metadata.state!=="ok"||metadata.fingerprint!==sha(JSON.stringify({brief,question})))throw new Error("Cached checkpoint is not unchanged verified-complete work");
  return {file,sha256:sha(text),fingerprint:metadata.fingerprint,state:metadata.state};
});}
function snapshot(worker:string,controller:string,run:RunPaths,paths:string[],label:string){
  const lock=ownedLock(run);for(const p of [...paths,`runs/${ID}/status.json`,`runs/${ID}/record.jsonl`]){const dest=join(controller,label,"worker",p);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(worker,p),dest);}
  const receipt={label,at:new Date().toISOString(),lock,history:history(run),immutableHashes:hashes(worker,paths),status:readStatus(run)};save(join(controller,`${label}-receipt.json`),receipt);return receipt;
}
function archiveSource(controller:string){
  const dirs=[".github","bin","docs","evals","evolution","playbook","plugins","profiles","prompts","scripts","src","test"],roots=[".gitignore","README.md","bun.lock","bunfig.toml","package.json","tsconfig.json"];
  const paths=[...dirs.flatMap(d=>existsSync(join(ROOT,d))?files(ROOT,d):[]),...roots.filter(p=>existsSync(join(ROOT,p)))].sort();
  for(const p of paths){if(/^(auth\.json|credentials\.json|\.env(?:\..*)?|.*\.(pem|key))$/i.test(p.split("/").at(-1)!))throw new Error("Sensitive-named source file refused");const dest=join(controller,"source",p);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(ROOT,p),dest);}
  return {coreSha256:sourceHash(join(controller,"source")),fullSha256:treeHash(join(controller,"source"),paths),files:paths.length};
}
function baselineFiles(controller:string){return ["protocol.json","execution.json","provider-ledger.json","result.json","effective-plan.json","executed-runner.ts","task.txt","result-reconciliation.json","synthesis-diagnosis.json"].filter(p=>existsSync(join(controller,p)));}
function originalBaseline(controller:string){
  const p=json(join(controller,"protocol.json")),worker=resolve(p.workerHome),run=runPaths(worker,ID),ledger=json(join(controller,"provider-ledger.json")),h=history(run);
  if(worker===resolve(kilnHome())||p.planningTargetUsd!==25||p.financialGuardUsd!==14||h.sha256!==EXPECTED_RECORD_SHA||Math.abs(ledger.chargedUsd-EXPECTED_PRIOR_CHARGED)>1e-10||ledger.requests!==22||ledger.activeReservations!==0||ledger.queuedRequests!==0)throw new Error("Original recovery lineage or settled accounting changed");
  const status=readStatus(run);if(status.phase!=="discover"||status.state!=="stopped"||status.outcome?.stopKind!=="deadline")throw new Error("Expected original saved discovery deadline");
  const cached=checkpoints(run);if(cached.length!==4)throw new Error("Expected exactly four unchanged successful scout checkpoints");
  for(const [file,digest]of Object.entries(p.helperHashes))if(sha(readFileSync(join(import.meta.dir,file)))!==digest)throw new Error("Original runner/evidence policy helper changed");
  const cfg=loadConfig(worker);if(cfg.budgets.usd!==25||cfg.budgets.wallSeconds!==1500)throw new Error("Original budgets must not be edited");
  return {p,worker,run,ledger,h,cached,cfg};
}
async function prepare(){
  const baselineArg=opt("--baseline-controller"),expected=opt("--expected-source-sha");if(!baselineArg||!expected||sourceHash()!==expected)throw new Error("Prepare requires frozen source SHA and explicit baseline controller");
  const baselineController=resolve(baselineArg),initial=originalBaseline(baselineController),lock=acquireRunLock(initial.run);
  try{
    const base=originalBaseline(baselineController),effective=applyFrozenRouting(base.cfg,base.run),now=Date.now();
    const cachedSynthesisWallMs=cachedDiscoverySynthesisWallMs(base.run,effective,new RunRecord(base.run.record),now,["frame","discover","ideate"]);
    const route=routeResume(readStatus(base.run),existsSync(base.run.frontier),effective,now,{cachedDiscoverySynthesis:cachedSynthesisWallMs>0});
    if(route.kind!=="phase"||route.phase!=="discover")throw new Error(`Native resume is not admitted without budget edits: ${JSON.stringify(route)}`);
    const controller=mkdtempSync(join(tmpdir(),"kiln-native-ideation-recovery-controller-"));chmodSync(controller,0o700);
    const paths=["config.json",...files(base.worker,"prompts"),...files(base.worker,"playbook"),...["seed.md","brief.md","workflow.json","routing.json"].map(p=>`runs/${ID}/${p}`),...base.cached.map(c=>`runs/${ID}/discovery/${c.file}`)].sort();
    const before=snapshot(base.worker,controller,base.run,paths,"prepared-before"),archive=archiveSource(controller);
    const originalFiles=baselineFiles(baselineController);for(const p of originalFiles){const dest=join(controller,"original-controller",p);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(baselineController,p),dest);}
    const limits=recoveryLimits({chargedUsd:base.ledger.chargedUsd,activeWallSeconds:base.h.activeWallSeconds,requests:base.ledger.requests});
    const protocol={version:1,label:"Explicit same-run cached-evidence recovery diagnostic; original failure preserved, no retrospective qualification pass",controller,baselineController,workerHome:base.worker,runId:ID,sourceSha256:expected,sourceArchive:archive,helperHashes:helperHashes(),baselineControllerHashes:hashes(baselineController,originalFiles),immutableHashes:before.immutableHashes,baselineHistory:base.h,baselineRecordedUsd:base.h.costUsd,baselineChargedUsd:base.ledger.chargedUsd,baselineObservedUsd:base.ledger.spentUsd,baselineRequests:base.ledger.requests,planningTargetUsd:25,logicalFinancialGuardUsd:14,logicalWallSeconds:1500,logicalMaxRequests:300,...limits,readinessPolicy:base.p.readinessPolicy,originalSourceSha256:base.p.sourceHash,baselineCheckpoints:base.cached,resumeRoute:route,cachedSynthesisWallMs,conditions:["Native explicit resume with cached checkpoints and frozen parameters", "Updated research contract/cutoff and bounded scheduling policy, separately frozen", "Owned source URLs and required coverage adequacy in the existing collision decision tighten evidence requirements", "Renderer version 2 exposes explicit evidence-gap reasons; no quality checks are waived", "Zero new discovery scouts or discovery tool-network requests; normal ideation evidence checks remain", "No config, routing, checkpoint or historical journal mutation", "No fallback, transport retry, learning, promotion, or extra recovery"],isolation:"Controller-only source and receipts; same existing worker, not OS isolation",preparedAt:new Date().toISOString()};
    if(sourceHash()!==expected||archive.coreSha256!==expected||immutableChanges(base.worker,before.immutableHashes).length||history(base.run).sha256!==base.h.sha256)throw new Error("State changed during locked recovery preparation");
    save(join(controller,"recovery-protocol.json"),protocol);console.log(JSON.stringify({controller,workerHome:base.worker,sourceSha256:expected,protocolSha256:sha(readFileSync(join(controller,"recovery-protocol.json"))),...limits,paidCalls:0}));
  }finally{lock.release();}
}
async function execute(){
  const controllerArg=opt("--controller"),expected=opt("--expected-source-sha"),expectedProtocol=opt("--expected-protocol-sha");if(!controllerArg||!expected||!expectedProtocol)throw new Error("Explicit recovery controller, frozen source and approved protocol hashes are required");
  const controller=resolve(controllerArg),p=json(join(controller,"recovery-protocol.json")),worker=resolve(p.workerHome),run=runPaths(worker,ID);
  if(sha(readFileSync(join(controller,"recovery-protocol.json")))!==expectedProtocol||!controller.includes("kiln-native-ideation-recovery-controller-")||controller===worker||sourceHash()!==expected||p.sourceSha256!==expected||JSON.stringify(helperHashes())!==JSON.stringify(p.helperHashes)||sourceHash(join(controller,"source"))!==expected||treeHash(join(controller,"source"),files(join(controller,"source")))!==p.sourceArchive.fullSha256)throw new Error("Recovery protocol, source or controller changed");
  const limits=recoveryLimits({chargedUsd:p.baselineChargedUsd,activeWallSeconds:p.baselineHistory.activeWallSeconds,requests:p.baselineRequests});
  if(JSON.stringify(limits)!==JSON.stringify({incrementalChargedCapUsd:p.incrementalChargedCapUsd,remainingWallMs:p.remainingWallMs,remainingRequests:p.remainingRequests}))throw new Error("Recovery allowances changed");
  claimExecution(join(controller,"attempt.json"),{at:new Date().toISOString(),sourceSha256:expected});
  const checkBaseline=()=>{const base=originalBaseline(p.baselineController);assertRecoveryAccounting(p,{chargedUsd:base.ledger.chargedUsd,recordedUsd:base.h.costUsd,observedUsd:base.ledger.spentUsd,requests:base.ledger.requests,historySha:base.h.sha256});if(worker!==base.worker||JSON.stringify(p.readinessPolicy)!==JSON.stringify(base.p.readinessPolicy)||immutableChanges(worker,p.immutableHashes).length||immutableChanges(p.baselineController,p.baselineControllerHashes).length||sourceHash()!==expected)throw new Error("Recovery baseline changed");};
  checkBaseline();
  const cfg=applyFrozenRouting(loadConfig(worker),run),runtime=await createCliRuntime(resolve(kilnHome()),cfg,{}),control=new RunControl(),pending=new Set<Promise<unknown>>();
  let requests=0,spent=0,charged=0,admitted=false,firstStream=true,timer:ReturnType<typeof setTimeout>|undefined,lastReceipt:any,unexpectedDiscoveryNetwork=0;
  const calls:any[]=[],receipts:any[]=[],errors:string[]=[],output:string[]=[];
  const gate=new FifoBudget(limits.incrementalChargedCapUsd,()=>{charged=gate.chargedUsd;ledger();});
  const ledger=()=>save(join(controller,"recovery-ledger.json"),{baselineChargedUsd:p.baselineChargedUsd,incrementalObservedUsd:spent,incrementalChargedUsd:charged,logicalChargedUsd:p.baselineChargedUsd+charged,incrementalRequests:requests,logicalRequests:p.baselineRequests+requests,activeReservations:gate.activeCount,queuedRequests:gate.queuedCount,calls});
  const capture=(phase:string)=>{ownedLock(run);lastReceipt={phase,at:new Date().toISOString(),history:history(run)};receipts.push(lastReceipt);save(join(controller,"phase-receipts.json"),receipts);};
  const phase=async<T>(name:string,fn:()=>Promise<T>):Promise<T>=>{ownedLock(run);try{return await fn();}finally{capture(name);}};
  const capped:StreamFn=(model,context,options)=>{
    control.signal.throwIfAborted();ownedLock(run);if(!admitted)throw new Error("Recovery dispatch before locked baseline receipt");
    if(firstStream){if(readStatus(run).phase!=="discover"||immutableChanges(worker,p.immutableHashes).length||sourceHash()!==expected||JSON.stringify(helperHashes())!==JSON.stringify(p.helperHashes))throw new Error("First recovery stream is not unchanged cached discovery");if(checkpoints(run).length!==4)throw new Error("Recovery cached work changed");firstStream=false;}
    if(readStatus(run).phase==="discover"&&`${model.provider}/${model.id}`!==runtime.models("brain").ref)throw new Error("Recovery refuses discovery scout replay");
    if(model.provider!=="anthropic")throw new Error("Unsupported provider wire guard");
    const text=JSON.stringify(context);if(text.includes(controller)||text.includes(p.baselineController)||text.includes(ROOT))throw new Error("Controller/source path leaked into worker request");
    if(requests>=limits.remainingRequests){control.cancel("Original cumulative request cap exhausted");throw control.signal.reason;}
    const entry:any={request:p.baselineRequests+(++requests),dispatched:false,state:"created",createdAt:new Date().toISOString(),model:`${model.provider}/${model.id}`,inputHash:contextInputHash(context)};calls.push(entry);ledger();
    const maxTokens=outputLimit(context),life=new AbortController(),signal=options?.signal?AbortSignal.any([options.signal,control.signal]):control.signal;let attempted=false,ticket:BudgetTicket|undefined;
    const guardedFetch:FetchImpl=async(url,init)=>{
      if(attempted)throw new Error("Recovery transport retries disabled");attempted=true;
      const queuedSignal=AbortSignal.any([signal,life.signal,...(init?.signal?[init.signal]:[]),...(url instanceof Request?[url.signal]:[])]);queuedSignal.throwIfAborted();
      const body=await requestBody(url,init),wire=JSON.parse(body);if(wire.model!==model.id||wire.max_tokens!==maxTokens)throw new Error("Recovery exact-wire model/output mismatch");
      const amount=reservation(model.cost,Buffer.byteLength(body),maxTokens),queuedAt=Date.now();Object.assign(entry,{state:"queued",requestedReserveUsd:amount,wireBytes:Buffer.byteLength(body),maxTokens});ledger();
      try{ticket=await gate.acquire(amount,queuedSignal);}catch(e){entry.state="not_dispatched";ledger();if(e instanceof QualificationBudgetExhausted)control.cancel(e);throw e;}
      if(queuedSignal.aborted){ticket.settle(0,"not_dispatched");queuedSignal.throwIfAborted();}
      Object.assign(entry,{dispatched:true,state:"dispatched",reserveUsd:ticket.reservedUsd,queueWaitMs:Date.now()-queuedAt});ledger();return coworkFetch(url,init);
    };
    const {fallbacks:_fallbacks,...rest}=options??{};
    const stream=streamSimple(model,context,{...rest,maxTokens,fetch:guardedFetch,signal,acceptEmptyResponse:true,preferWebsockets:false});
    const settled=stream.result().then(m=>{life.abort("stream settled");const actual=entry.dispatched?modelCostUsd(model,m.usage):0,keep=ticket?.settle(actual,entry.dispatched?m.stopReason:"not_dispatched")??0;spent+=actual;Object.assign(entry,{costUsd:actual,chargedUsd:keep,usage:Object.fromEntries(USAGE_FIELDS.map(k=>[k,m.usage[k]])),stop:m.stopReason,state:entry.dispatched?"settled":"not_dispatched"});ledger();if(p.baselineChargedUsd+charged>14)control.cancel("Original logical financial cap reached");},e=>{life.abort(e);const keep=ticket?.settle(0,entry.dispatched?"error":"not_dispatched")??0;Object.assign(entry,{error:String(e),chargedUsd:keep,stop:"error",usage:null});ledger();if(entry.dispatched)control.cancel("Recovery provider failure; reservation retained");});
    pending.add(settled);void settled.finally(()=>pending.delete(settled));return stream;
  };
  const noDiscoveryNetwork=((...args:Parameters<typeof fetch>)=>{if(readStatus(run).phase==="discover"){unexpectedDiscoveryNetwork++;control.cancel("Recovery refuses new discovery network research");return Promise.reject(control.signal.reason);}return fetch(...args);}) as typeof fetch;
  let code=1,error:string|undefined;
  try{code=await withRunControl(control,()=>main(["run","resume",ID,"--home",worker,"--through","checkpoint","--autonomous","--yes","--json"],{write:t=>output.push(t),error:t=>errors.push(t)},{apiKeyFor:runtime.apiKeyFor,fetchUsage:runtime.fetchUsage,fetchImpl:noDiscoveryNetwork,streamFn:capped,
    onRun:active=>{ownedLock(active);if(active.dir!==run.dir)throw new Error("Unexpected recovery worker run");checkBaseline();assertNativePlan(active);const start=snapshot(worker,controller,active,Object.keys(p.immutableHashes),"execution-before");lastReceipt={phase:"onRun",at:start.at,history:start.history};receipts.push(lastReceipt);save(join(controller,"phase-receipts.json"),receipts);claimExecution(join(controller,"execution.json"),{at:new Date().toISOString(),sourceSha256:expected,baselineHistory:start.history,limits});admitted=true;timer=setTimeout(()=>control.cancel("Original remaining active wall exhausted"),limits.remainingWallMs);},
    runFrame:async()=>{throw new Error("Recovery refuses reframing");},
    runDiscover:d=>phase("discover",()=>runDiscover(d)),runIdeate:d=>phase("ideate",()=>runIdeate(d)),runCheckpoint:(d,io,o)=>phase("checkpoint",()=>runCheckpoint(d,io,o)),
  }));}catch(e){error=String(e);}finally{if(timer)clearTimeout(timer);await Promise.allSettled([...pending]);}
  const integrityErrors:string[]=[];let final:any,events:any[]=[],frontier:any=null,tournament:any[]=[],evidenceByIdea:Record<string,any>={},metrics:unknown,journalOwnership:any,callAccounting:any;
  try{const lock=acquireRunLock(run);try{
    const before=readFileSync(join(controller,"prepared-before","worker","runs",ID,"record.jsonl")),after=readFileSync(run.record);
    if(!preservedPrefix(before,after))integrityErrors.push("Original journal prefix changed");
    integrityErrors.push(...immutableChanges(worker,p.immutableHashes).map(x=>`Worker immutable changed: ${x}`),...immutableChanges(p.baselineController,p.baselineControllerHashes).map(x=>`Original controller changed: ${x}`));
    if(JSON.stringify(files(run.discoveryDir).sort())!==JSON.stringify(p.baselineCheckpoints.map((c:any)=>c.file).sort()))integrityErrors.push("Discovery checkpoint inventory changed");
    if(sourceHash()!==expected||JSON.stringify(helperHashes())!==JSON.stringify(p.helperHashes))integrityErrors.push("Frozen recovery source/helpers changed");
    journalOwnership=admitted?verifyFinalJournal(after,lastReceipt,control.signal.aborted,readStatus(run)):{ok:true,kind:"not-admitted"};
    if(!journalOwnership.ok)integrityErrors.push(`Final journal is not the owned receipt or exact native controller-cancellation closure: ${journalOwnership.kind}`);
    events=new RunRecord(run.record).read();const added=events.filter(e=>e.seq>p.baselineHistory.lastSequence);
    let currentPhase="discover";for(const e of added){if(e.t==="phase.start")currentPhase=e.phase;if(currentPhase==="discover"&&((e.t==="model.call"&&e.role==="scout")||(e.t==="tool.call"&&["web_search","web_fetch","scholar_search","scout"].includes(e.name))))integrityErrors.push("Unexpected discovery research/replay in recovery trace");}
    callAccounting=reconcileRecordedCalls(calls,added.filter(e=>e.t==="model.call"),control.signal.aborted);integrityErrors.push(...callAccounting.errors);
    final=snapshot(worker,controller,run,Object.keys(p.immutableHashes),"after");
    if(existsSync(run.frontier))frontier=json(run.frontier);if(existsSync(run.tournament))tournament=readFileSync(run.tournament,"utf8").split("\n").filter(Boolean).map(s=>JSON.parse(s));
    for(const id of Array.isArray(frontier?.shown)?frontier.shown:[])if(typeof id==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)&&!id.includes("..")){try{const e=json(join(run.ideasDir,`${id}.evidence.json`)),render=join(run.renderedDir,`${id}-r${frontier.round}.md`);evidenceByIdea[id]={...e,renderPresent:existsSync(render)&&readFileSync(render,"utf8").trim().length>0};}catch{}}
    try{metrics=computeMetrics(run);}catch{}
  }finally{lock.release();}}catch(e){integrityErrors.push(`Final locked snapshot unavailable: ${String(e)}`);}
  const preserved=integrityErrors.length===0,readiness=completionEvidence(events,code,frontier,{tournament,evidenceByIdea,cancelled:control.signal.aborted,sourceUnchanged:preserved,status:final?.status});
  const logicalRecordedUsd=final?.history.costUsd??null,incrementalRecordedUsd=logicalRecordedUsd===null?null:logicalRecordedUsd-p.baselineRecordedUsd;
  const report={label:p.label,controller,baselineController:p.baselineController,workerHome:worker,code,error,errors,integrityErrors,preserved,journalOwnership,callAccounting,baselineRecordedUsd:p.baselineRecordedUsd,baselineChargedUsd:p.baselineChargedUsd,incrementalRecordedUsd,incrementalObservedUsd:spent,incrementalChargedUsd:charged,logicalRecordedUsd,logicalObservedUsd:p.baselineObservedUsd+spent,logicalChargedUsd:p.baselineChargedUsd+charged,logicalUncertaintyAboveRecordedUsd:logicalRecordedUsd===null?null:p.baselineChargedUsd+charged-logicalRecordedUsd,incrementalRequests:requests,logicalRequests:p.baselineRequests+requests,remainingLimits:limits,activeWallSeconds:final?.history.activeWallSeconds??null,unexpectedDiscoveryNetwork,...readiness,status:final?.status,frontier,metrics,phaseReceipts:receipts,output,finishedAt:new Date().toISOString()};
  save(join(controller,"recovery-result.json"),report);console.log(JSON.stringify({controller,code,incrementalRecordedUsd,logicalRecordedUsd,logicalChargedUsd:report.logicalChargedUsd,preserved,checkpointDelivered:report.checkpointDelivered,taskReadyForReview:report.taskReadyForReview}));await finishProcess(error||!preserved?1:code);
}
if(import.meta.main){if(Bun.argv.includes("--prepare"))await prepare();else if(Bun.argv.includes("--confirm-spend"))await execute();else throw new Error("Explicit frozen prepare or approved single-use recovery required");}
