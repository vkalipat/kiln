/** Native CLI qualification. Controller artifacts are outside the worker home. */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { main } from "../../src/cli/main";
import { createCliRuntime } from "../../src/cli/runtime";
import { finishProcess } from "../../src/cli/exit";
import { loadConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { RunRecord } from "../../src/core/record";
import { runPaths, readStatus, type RunPaths } from "../../src/core/run";
import { RunControl, withRunControl } from "../../src/core/run-control";
import { loadFrozenRouting } from "../../src/workflow/routing";
import { loadWorkflowPlan, compileWorkflow } from "../../src/workflow/plan";
import { computeMetrics } from "../../src/ideation/metrics";
import { modelCostUsd } from "../../src/providers/models";
import { requestBody } from "./runtime-pilot";
import { reservation, settleReservation } from "./delivery-recovery-pilot";
import { outputLimit } from "./ideation-validation";
import { seedIdentity } from "../../src/evals/identity";

const ROOT = resolve(import.meta.dir, "../.."), ID = "native-adaptive-ideation";
export const QUALIFICATION_TASK = "Find three genuinely different, evidence-backed ways a small software team could reduce the time independent repair businesses spend turning customer emails into accurate quotes. Assume a two-person team and a six-week prototype window. Research existing products so the proposals have a concrete distinction from existing offerings; compare value, feasibility, and differentiation; recommend the strongest starting point and explain what evidence could invalidate it. Deliver an ideation shortlist and recommendation only. Do not build, buy anything, contact people, or deploy services.";
export const CAP_USD = 14; // External charged-exposure ceiling; distinct from native planning target.
export const PLANNING_TARGET_USD = 25;
const READINESS_POLICY={minimumDistinctShownIds:3,minimumCompleteAbBaOpponentsPerShownId:3,minimumValueAndFeasibilityComparisons:3,requireActiveRenderedEligibleIdeas:true,requireShownPriorArtStatus:"not_falsified",requireHealthySearchAndNoveltyEnforcement:true,probeOutcomes:"reported per shown idea; manual review required",citationAccuracyNoveltyAndCustomerOutcomes:"not automatically established",qualityScore:null};
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function sourceHash() {
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir,e.name)) : e.isFile() ? [join(dir,e.name)] : []);
  const paths = [...walk("src"), ...walk("bin"), ...walk("prompts"), "package.json", "bun.lock"].filter(p => existsSync(join(ROOT,p))).sort();
  const hash=createHash("sha256"); for(const p of paths) hash.update(p).update("\0").update(readFileSync(join(ROOT,p))).update("\0"); return hash.digest("hex");
}
const helperHashes = () => Object.fromEntries(["adaptive-ideation-validation.ts","ideation-validation.ts","runtime-pilot.ts","delivery-recovery-pilot.ts"].map(p=>[p,sha(readFileSync(join(import.meta.dir,p)))]));
const opt = (name:string) => {const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
export function assertNativePlan(run: RunPaths) {
  const workflow=loadWorkflowPlan(run), routing=loadFrozenRouting(run);
  if(!workflow || !routing || !readStatus(run).routingRequired) throw new Error("Expected persisted native adaptive workflow and routing before dispatch");
  if(workflow.strategy?.mode!=="exploratory"||workflow.strategy.research!=="broad") throw new Error("Expected native exploratory research classification");
  const execution=compileWorkflow(workflow,{through:"checkpoint",autonomous:true});
  if(!execution.phases.includes("ideate") || execution.through!=="checkpoint") throw new Error("Native plan does not deliver ideation through checkpoint");
  if(routing.ideationProfile?.minComparisons!==3) throw new Error("Diagnostic must preserve minimum three comparisons");
  return {workflow,execution,routing};
}
export function validCap(value: unknown): value is number { return typeof value==="number"&&Number.isFinite(value)&&value>0&&value<=CAP_USD; }
export function claimExecution(path:string,value:unknown):void {
  const fd=openSync(path,"wx",0o600);try{writeFileSync(fd,JSON.stringify(value));}finally{closeSync(fd);}
}
export class QualificationBudgetExhausted extends Error {}
export interface BudgetTicket { readonly reservedUsd:number; settle(actualUsd:number,stop:string):number }
/** FIFO wire admission. Queued, undispatched work consumes no reservation. */
export class FifoBudget {
  private settledUsd=0;
  private active=new Map<number,number>();
  private nextId=0;
  private exhausted:QualificationBudgetExhausted|undefined;
  private queue:Array<{amount:number;resolve:(ticket:BudgetTicket)=>void;reject:(error:unknown)=>void;cleanup:()=>void}>=[];
  constructor(readonly limitUsd:number,private readonly changed:()=>void=()=>{}) {
    if(!Number.isFinite(limitUsd)||limitUsd<=0)throw new Error("Budget must be finite and positive");
  }
  get chargedUsd(){return this.settledUsd+[...this.active.values()].reduce((n,v)=>n+v,0);}
  get settledExposureUsd(){return this.settledUsd;}
  get activeCount(){return this.active.size;}
  get queuedCount(){return this.queue.length;}
  acquire(amount:number,signal?:AbortSignal):Promise<BudgetTicket>{
    if(!Number.isFinite(amount)||amount<0)return Promise.reject(new Error("Invalid wire reservation"));
    if(signal?.aborted)return Promise.reject(signal.reason??new Error("Queued request cancelled"));
    if(this.exhausted)return Promise.reject(this.exhausted);
    return new Promise((resolve,reject)=>{
      const entry={amount,resolve,reject,cleanup:()=>{}};
      const abort=()=>{const i=this.queue.indexOf(entry);if(i<0)return;this.queue.splice(i,1);entry.cleanup();reject(signal?.reason??new Error("Queued request cancelled"));this.drain();};
      entry.cleanup=()=>signal?.removeEventListener("abort",abort);
      signal?.addEventListener("abort",abort,{once:true});this.queue.push(entry);this.drain();
    });
  }
  private drain(){
    while(this.queue.length){
      const entry=this.queue[0]!;
      if(this.chargedUsd+entry.amount>this.limitUsd){
        if(this.active.size>0)break; // Settling current requests may release headroom.
        this.exhausted=new QualificationBudgetExhausted("Exact wire request cannot fit remaining settled and retained budget");
        for(const waiting of this.queue.splice(0)){waiting.cleanup();waiting.reject(this.exhausted);}break;
      }
      this.queue.shift();entry.cleanup();const id=++this.nextId;this.active.set(id,entry.amount);
      let done=false,kept=0;
      entry.resolve({reservedUsd:entry.amount,settle:(actual,stop)=>{
        if(done)return kept;done=true;
        kept=settleReservation(entry.amount,actual,stop);this.active.delete(id);this.settledUsd+=kept;this.drain();return kept;
      }});
    }
    this.changed();
  }
}
const validIdeaId=(id:unknown):id is string=>typeof id==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)&&!id.includes("..");
export function completionEvidence(events: Array<{t:string;[key:string]:unknown}>, code:number, frontier:any, audit:{tournament?:any[];evidenceByIdea?:Record<string,any>;cancelled?:boolean;sourceUnchanged?:boolean;status?:any}={}) {
  const shownEvents=events.filter(e=>e.t==="checkpoint.shown"),shownEvent=shownEvents.at(-1);
  const index=shownEvent?events.lastIndexOf(shownEvent):-1;
  const pick=events.slice(index+1).find(e=>e.t==="checkpoint.decision"&&e.kind==="autonomous_pick");
  const shown=Array.isArray(shownEvent?.ideas)?shownEvent.ideas:[];
  const frontierIds=new Set(Array.isArray(frontier?.shown)?frontier.shown:[]),eligible=new Set(Array.isArray(frontier?.eligible)?frontier.eligible:[]);
  const entries=new Map<string,any>((Array.isArray(frontier?.ideas)?frontier.ideas:[]).filter((i:any)=>validIdeaId(i?.id)).map((i:any)=>[i.id,i]));
  const validShown=[...new Set(shown.filter(id=>validIdeaId(id)&&frontierIds.has(id)&&entries.has(id)))];
  const healthy=code===0&&audit.cancelled===false&&audit.sourceUnchanged===true&&audit.status?.state==="running"&&audit.status?.phase==="form";
  const selected=validIdeaId(pick?.id)?pick.id:null;
  const checkpointDelivered=healthy&&frontier?.version===1&&shownEvent?.round===frontier?.round&&validShown.length>0&&validShown.length===new Set(shown).size&&selected!==null&&validShown.includes(selected)&&eligible.has(selected)&&Array.isArray(frontier.rawFront)&&frontier.rawFront.includes(selected)&&audit.status.chosenIdeaId===selected;
  const pairs=new Map<string,{a:string;b:string;orders:Set<string>}>();
  for(const line of audit.tournament??[]){
    if(line.round!==frontier?.round||line.source!=="judge"||!validIdeaId(line.a)||!validIdeaId(line.b)||line.a===line.b||!["ab","ba"].includes(line.order)||!["a","b","tie"].includes(line.valueWinner)||!["a","b","tie"].includes(line.feasibilityWinner))continue;
    const key=JSON.stringify([line.round,line.a,line.b,line.criteriaId]);const pair=pairs.get(key)??{a:line.a,b:line.b,orders:new Set<string>()};pair.orders.add(line.order);pairs.set(key,pair);
  }
  const shownEvidence=validShown.map(id=>{
    const e=audit.evidenceByIdea?.[id],item=entries.get(id),complete=new Set<string>(),incomplete=new Set<string>();
    for(const pair of pairs.values())if(pair.a===id||pair.b===id){const other=pair.a===id?pair.b:pair.a;(pair.orders.has("ab")&&pair.orders.has("ba")?complete:incomplete).add(other);}
    const eligibleWithCoverage=eligible.has(id)&&e?.status==="active"&&e?.renderPresent===true&&complete.size>=3&&incomplete.size===0&&item?.value?.n>=3&&item?.feasibility?.n>=3&&e?.strengths?.value?.n>=3&&e?.strengths?.feasibility?.n>=3;
    return {id,eligibleWithCoverage,completeAbBaOpponents:complete.size,incompleteAbBaOpponents:incomplete.size,valueComparisons:e?.strengths?.value?.n??null,feasibilityComparisons:e?.strengths?.feasibility?.n??null,priorArtStatus:e?.priorArt?.status??"not_checked",priorArtArtifact:e?.priorArt?.artifact??null,probeStatus:e?.probe?.status??"not_run",probeReason:e?.probe?.reason??null};
  });
  const searchDegraded=frontier?.noveltyEnforced!==true||!Number.isFinite(frontier?.searchHealth)||!Number.isFinite(frontier?.searchHealthFloor)||frontier.searchHealth<frontier.searchHealthFloor;
  const warnings:string[]=[];
  if(searchDegraded)warnings.push("Search degraded or novelty enforcement disabled: checkpoint is not a grounded-task success.");
  if(shownEvidence.some(e=>e.probeStatus!=="pass"))warnings.push("Some shown ideas have no passing probe; inspect individual probe outcomes.");
  return {checkpointDelivered,taskReadyForReview:checkpointDelivered&&shownEvidence.length>=3&&shownEvidence.every(e=>e.eligibleWithCoverage&&e.priorArtStatus==="not_falsified")&&!searchDegraded,taskReadyMeaning:"Structural readiness for manual review, not verified citation accuracy, novelty or customer outcomes",checkpointShownEvents:shownEvents.length,distinctValidShownIdeas:validShown.length,chosenIdeaId:selected,shownEvidence,searchDegraded,noveltyEnforced:frontier?.noveltyEnforced??null,warnings,manualSourceAudit:"pending",qualityScore:null};
}
async function prepare() {
  const expected=opt("--expected-source-sha"), cap=Number(opt("--cap-usd")??CAP_USD);
  if(!expected||sourceHash()!==expected) throw new Error("Prepare requires current parent-approved production source SHA");
  if(!validCap(cap)) throw new Error("Cap must be positive and at most fourteen dollars");
  const controller=mkdtempSync(join(tmpdir(),"kiln-native-ideation-controller-"));
  const workerHome=mkdtempSync(join(tmpdir(),"kiln-native-ideation-worker-"));
  chmodSync(controller,0o700);chmodSync(workerHome,0o700);initHome(workerHome,{plugAndPlay:true});
  const cfg=loadConfig(resolve(kilnHome()));cfg.routing={mode:"adaptive"};cfg.autonomous=true;cfg.provider.fallbacks="off";
  cfg.budgets.usd=PLANNING_TARGET_USD;cfg.budgets.wallSeconds=1500;saveConfig(workerHome,cfg);
  const protocol={version:2,label:"Changed-condition diagnostic on a previously seen business task; not a successful ten-dollar qualification, rescore, heldout benchmark or general quality score",controller,workerHome,taskHash:sha(QUALIFICATION_TASK),persistedSeedHash:sha(QUALIFICATION_TASK+"\n"),sourceHash:expected,helperHashes:helperHashes(),configHash:sha(readFileSync(join(workerHome,"config.json"))),planningTargetUsd:PLANNING_TARGET_USD,financialGuardUsd:cap,capUsd:cap,priorCase:"PdeHLo/dIVO1N: ten-dollar planning target stopped at four local scout quotas; preserved without rescore",changedConditions:["Native default25-dollar planning target; separate14-dollar maximum charged-exposure guard","Funded discovery fanout and dollar-based soft finish in newly frozen production source"],wallSeconds:1500,maxRequests:300,outputCaps:{general:16384,verdictCritique:32768},resume:false,fallback:false,transportRetries:false,learning:false,promotion:false,isolation:"Separate controller directory and native run tool roots; NOT OS isolation. No controller/evaluator/source paths provided to worker. Manual audit required before treating output as evidence."};
  writeAtomic(join(controller,"task.txt"),QUALIFICATION_TASK,{mode:0o600});
  writeAtomic(join(controller,"protocol.json"),JSON.stringify({...protocol,readinessPolicy:READINESS_POLICY},null,2),{mode:0o600});
  writeAtomic(join(controller,"executed-runner.ts"),readFileSync(import.meta.filename,"utf8"),{mode:0o600});
  console.log(JSON.stringify({controller,workerHome,sourceHash:expected,planningTargetUsd:PLANNING_TARGET_USD,financialGuardUsd:cap,paidCalls:0}));
}
async function run() {
  const supplied=opt("--controller"),expected=opt("--expected-source-sha");if(!supplied||!expected)throw new Error("Paid run requires controller and source SHA");
  const controller=resolve(supplied),p=JSON.parse(readFileSync(join(controller,"protocol.json"),"utf8"));
  const workerHome=resolve(p.workerHome),authHome=resolve(kilnHome());
  if(controller===workerHome||workerHome===authHome||!controller.includes("kiln-native-ideation-controller-")||!workerHome.includes("kiln-native-ideation-worker-"))throw new Error("Controller/worker separation invalid");
  if(existsSync(join(controller,"execution.json"))||existsSync(runPaths(workerHome,ID).status))throw new Error("Refuse duplicate, resume or ledger reset");
  if(p.sourceHash!==expected||sourceHash()!==expected||JSON.stringify(p.helperHashes)!==JSON.stringify(helperHashes()))throw new Error("Frozen source changed");
  if(p.version!==2||!validCap(p.capUsd)||p.financialGuardUsd!==p.capUsd||p.planningTargetUsd!==PLANNING_TARGET_USD||sha(readFileSync(join(workerHome,"config.json")))!==p.configHash||loadConfig(workerHome).budgets.usd!==PLANNING_TARGET_USD)throw new Error("Protocol planning target, financial cap or config changed");
  const seed=readFileSync(join(controller,"task.txt"),"utf8");if(seed!==QUALIFICATION_TASK||sha(seed)!==p.taskHash)throw new Error("Frozen qualification task changed");
  if(seedIdentity(workerHome,seed))throw new Error("Qualification cannot dispatch a canonical evaluator seed");
  claimExecution(join(controller,"execution.json"),{startedAt:new Date().toISOString(),sourceHash:expected,planningTargetUsd:p.planningTargetUsd,financialGuardUsd:p.financialGuardUsd});
  const runtime=await createCliRuntime(authHome,loadConfig(workerHome),{}), control=new RunControl(),pending=new Set<Promise<unknown>>();
  let spent=0,charged=0,requests=0,planFrozen=false;const calls:any[]=[];
  const admission=new FifoBudget(p.capUsd,()=>{charged=admission.chargedUsd;ledger();});
  const ledger=()=>writeAtomic(join(controller,"provider-ledger.json"),JSON.stringify({planningTargetUsd:p.planningTargetUsd,financialGuardUsd:p.financialGuardUsd,spentUsd:spent,chargedUsd:charged,settledExposureUsd:admission.settledExposureUsd,activeReservations:admission.activeCount,queuedRequests:admission.queuedCount,requests,calls},null,2),{mode:0o600});
  const capped:StreamFn=(model,context,options)=>{
    control.signal.throwIfAborted();if(!planFrozen)throw new Error("Dispatch before native plan freeze");
    if(model.provider!=="anthropic")throw new Error("Unexpected provider; wire guard fails closed");
    const serialized=JSON.stringify(context);if(serialized.includes(controller)||serialized.includes(ROOT))throw new Error("Controller or source workspace path present in worker payload");
    const maxTokens=outputLimit(context),queueLifetime=new AbortController();let dispatched=false,fetchAttempted=false,ticket:BudgetTicket|undefined;
    if(requests>=300){control.cancel("Qualification request limit exhausted");throw control.signal.reason;}
    const signal=options?.signal?AbortSignal.any([options.signal,control.signal]):control.signal;
    const entry:any={request:++requests,model:`${model.provider}/${model.id}`,maxTokens,reserveUsd:0,dispatched:false,state:"created",createdAt:new Date().toISOString()};calls.push(entry);ledger();
    const guardedFetch:FetchImpl=async(url,init)=>{
      if(fetchAttempted)throw new Error("Transport retry disabled");fetchAttempted=true;
      const queueSignal=AbortSignal.any([signal,queueLifetime.signal,...(init?.signal?[init.signal]:[]),...(url instanceof Request?[url.signal]:[])]);
      queueSignal.throwIfAborted();
      const body=await requestBody(url,init),wire=JSON.parse(body);if(wire.model!==model.id||wire.max_tokens!==maxTokens)throw new Error("Wire model/output mismatch");
      const exact=reservation(model.cost,Buffer.byteLength(body),maxTokens);
      const queuedAt=Date.now();Object.assign(entry,{requestedReserveUsd:exact,wireBytes:Buffer.byteLength(body),state:"queued",queuedAt:new Date(queuedAt).toISOString()});ledger();
      try{ticket=await admission.acquire(exact,queueSignal);}catch(e){entry.state="not_dispatched";ledger();if(e instanceof QualificationBudgetExhausted)control.cancel(e);throw e;}
      if(queueSignal.aborted){ticket.settle(0,"not_dispatched");entry.state="not_dispatched";ledger();queueSignal.throwIfAborted();}
      dispatched=true;Object.assign(entry,{dispatched,reserveUsd:ticket.reservedUsd,state:"dispatched",dispatchedAt:new Date().toISOString(),queueWaitMs:Date.now()-queuedAt});ledger();return coworkFetch(url,init);
    };
    const {fallbacks:_fallbacks,...rest}=options??{};
    const stream=streamSimple(model,context,{...rest,maxTokens,fetch:guardedFetch,signal,acceptEmptyResponse:true,preferWebsockets:false});
    const done=stream.result().then(m=>{queueLifetime.abort("Provider stream settled");const actual=dispatched?modelCostUsd(model,m.usage):0,keep=ticket?.settle(actual,dispatched?m.stopReason:"not_dispatched")??0;spent+=actual;Object.assign(entry,{costUsd:actual,chargedUsd:keep,stop:m.stopReason,state:dispatched?"settled":"not_dispatched",finishedAt:new Date().toISOString()});ledger();if(charged>p.capUsd)control.cancel("Qualification cap reached");},e=>{queueLifetime.abort(e);const keep=ticket?.settle(0,dispatched?"error":"not_dispatched")??0;Object.assign(entry,{error:String(e),chargedUsd:keep,state:dispatched?"settled":"not_dispatched",finishedAt:new Date().toISOString()});ledger();if(dispatched)control.cancel("Provider failure; unknown reservation retained");});
    pending.add(done);void done.finally(()=>pending.delete(done));return stream;
  };
  const timer=setTimeout(()=>control.cancel("Qualification 1500-second deadline"),1500000);let code=1,error:string|undefined;const output:string[]=[],errors:string[]=[];
  try{code=await withRunControl(control,()=>main(["run","new",seed,"--id",ID,"--home",workerHome,"--through","checkpoint","--autonomous","--yes","--json"],{write:t=>output.push(t),error:t=>errors.push(t)},{apiKeyFor:runtime.apiKeyFor,fetchUsage:runtime.fetchUsage,streamFn:capped,
    // Do not inject models or disable runtimeEffort: both bypass the native adaptive path.
    onRun:run=>{const plan=assertNativePlan(run);writeAtomic(join(controller,"effective-plan.json"),JSON.stringify({sourceHash:expected,...plan},null,2),{mode:0o600});planFrozen=true;console.log(JSON.stringify({workerRun:run.dir,planFrozen:true}));}
  }));}catch(e){error=String(e);}finally{clearTimeout(timer);await Promise.allSettled([...pending]);}
  const paths=runPaths(workerHome,ID),events=existsSync(paths.record)?new RunRecord(paths.record).read():[];
  const frontier=existsSync(paths.frontier)?JSON.parse(readFileSync(paths.frontier,"utf8")):null;
  const tournament=existsSync(paths.tournament)?readFileSync(paths.tournament,"utf8").split("\n").filter(Boolean).map(s=>JSON.parse(s)):[];
  let metrics:unknown;try{metrics=computeMetrics(paths);}catch{}
  const citations=events.flatMap(e=>e.t==="tool.call"&&e.name==="web_fetch"?[{ok:e.ok,args:e.args}]:[]);
  const status=existsSync(paths.status)?readStatus(paths):null,sourceUnchanged=sourceHash()===expected;
  const evidenceByIdea:Record<string,any>={};
  for(const id of Array.isArray(frontier?.shown)?frontier.shown:[]){if(!validIdeaId(id))continue;try{const e=JSON.parse(readFileSync(join(paths.ideasDir,`${id}.evidence.json`),"utf8"));const render=join(paths.renderedDir,`${id}-r${frontier.round}.md`);evidenceByIdea[id]={...e,renderPresent:existsSync(render)&&readFileSync(render,"utf8").trim().length>0};}catch{evidenceByIdea[id]={renderPresent:false};}}
  const readiness=completionEvidence(events as any,code,frontier,{tournament,evidenceByIdea,cancelled:control.signal.aborted,sourceUnchanged,status});
  const report={label:p.label,planningTargetUsd:p.planningTargetUsd,financialGuardUsd:p.financialGuardUsd,changedConditions:p.changedConditions,code,error,errors,status,sourceUnchanged,canonicalRecordedUsd:existsSync(paths.record)?new RunRecord(paths.record).costUsd():0,providerObservedUsd:spent,chargedUsd:charged,requests,...readiness,ideasInserted:events.filter(e=>e.t==="idea.insert").length,generationCalls:events.filter(e=>e.t==="model.call"&&e.role==="generator").length,frontier,metrics,tournamentRows:tournament.length,comparisonOrderCounts:tournament.reduce((a:any,r:any)=>(a[r.order]=(a[r.order]??0)+1,a),{}),phaseOutcomes:events.filter(e=>e.t==="phase.start"||e.t==="phase.end"),probes:events.filter(e=>e.t==="probe"),openedSourceAttempts:citations,output,manualAudit:"Required: inspect completed workflow artifact, citation validity and tool calls; no OS isolation or quality score claimed",finishedAt:new Date().toISOString()};
  writeAtomic(join(controller,"result.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({controller,workerHome,code,checkpointDelivered:report.checkpointDelivered,taskReadyForReview:report.taskReadyForReview,searchDegraded:report.searchDegraded,warnings:report.warnings,manualSourceAudit:report.manualSourceAudit,canonicalRecordedUsd:report.canonicalRecordedUsd,chargedUsd:charged}));await finishProcess(code);
}
if(import.meta.main){if(Bun.argv.includes("--prepare"))await prepare();else if(Bun.argv.includes("--confirm-spend"))await run();else throw new Error("Prepare only after production freeze; paid run requires explicit authorization and frozen source SHA");}
