import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryLimits, preservedPrefix, immutableChanges, assertRecoveryAccounting, assertRecoveryLock, reconcileRecordedCalls, verifyFinalJournal } from "../../scripts/benchmarks/adaptive-ideation-recovery";
import { FifoBudget, QualificationBudgetExhausted, claimExecution } from "../../scripts/benchmarks/adaptive-ideation-validation";
import { initHome } from "../../src/core/home";
import { createRun, readStatus, writeStatus } from "../../src/core/run";
import { acquireRunLock } from "../../src/core/lock";
import { elapsedByPhase } from "../../src/core/budget";
import { defaultConfig, saveConfig, loadConfig } from "../../src/core/config";
import { ensureWorkflowPlan, compileWorkflow } from "../../src/workflow/plan";
import { applyWorkflowProfile } from "../../src/workflow/profile";
import { planAdaptiveRouting } from "../../src/routing/adaptive";
import { freezeRouting } from "../../src/workflow/routing";
import { main } from "../../src/cli/main";
import { QUALIFICATION_TASK } from "../../scripts/benchmarks/adaptive-ideation-validation";

test("recovery inherits remaining financial, wall and request allowances",()=>{
  const limits=recoveryLimits({chargedUsd:5.673911,activeWallSeconds:300.017,requests:22});
  expect(limits.incrementalChargedCapUsd).toBeCloseTo(8.326089,10);
  expect(limits.remainingWallMs).toBe(1199983);expect(limits.remainingRequests).toBe(278);
  for(const prior of [{chargedUsd:14,activeWallSeconds:300,requests:22},{chargedUsd:5,activeWallSeconds:1500,requests:22},{chargedUsd:5,activeWallSeconds:300,requests:300},{chargedUsd:NaN,activeWallSeconds:300,requests:22}])expect(()=>recoveryLimits(prior)).toThrow();
});
test("baseline charged exposure is counted once and unknown new costs remain charged",async()=>{
  const prior=5.673911,gate=new FifoBudget(recoveryLimits({chargedUsd:prior,activeWallSeconds:300.017,requests:22}).incrementalChargedCapUsd);
  const a=await gate.acquire(3);a.settle(.2,"stop");expect(prior+gate.chargedUsd).toBeCloseTo(5.873911,10);
  const b=await gate.acquire(4);b.settle(0,"aborted");expect(prior+gate.chargedUsd).toBeCloseTo(9.873911,10);
  await expect(gate.acquire(5)).rejects.toBeInstanceOf(QualificationBudgetExhausted);expect(prior+gate.chargedUsd).toBeLessThanOrEqual(14);
});
test("protocol cannot reset prior charged, recorded, observed, request or history identity",()=>{
  const baseline={chargedUsd:5.673911,recordedUsd:2.7497595,observedUsd:2.670131,requests:22,historySha:"original"};
  const p={baselineChargedUsd:baseline.chargedUsd,baselineRecordedUsd:baseline.recordedUsd,baselineObservedUsd:baseline.observedUsd,baselineRequests:22,baselineHistory:{sha256:"original"}};
  expect(()=>assertRecoveryAccounting(p,baseline)).not.toThrow();
  for(const field of ["baselineChargedUsd","baselineRecordedUsd","baselineObservedUsd","baselineRequests"]){expect(()=>assertRecoveryAccounting({...p,[field]:0},baseline)).toThrow();}
  expect(()=>assertRecoveryAccounting({...p,baselineHistory:{sha256:"replacement"}},baseline)).toThrow();
});
test("old journal remains a byte-identical prefix and immutable file drift is detected",()=>{
  const before=Buffer.from('{"seq":1}\n');expect(preservedPrefix(before,Buffer.concat([before,Buffer.from('{"seq":2}\n')]))).toBe(true);
  expect(preservedPrefix(before,Buffer.from('{"seq":2}\n'))).toBe(false);expect(preservedPrefix(before,before.subarray(0,4))).toBe(false);
  const dir=mkdtempSync(join(tmpdir(),"kiln-recovery-immutable-test-")),path=join(dir,"checkpoint.md");writeFileSync(path,"cached facts");
  const manifest={"checkpoint.md":createHash("sha256").update(readFileSync(path)).digest("hex")};expect(immutableChanges(dir,manifest)).toEqual([]);
  writeFileSync(path,"changed facts");expect(immutableChanges(dir,manifest)).toEqual(["checkpoint.md"]);
});
test("locked receipts cannot be taken outside native run ownership and claims are exclusive",()=>{
  const home=mkdtempSync(join(tmpdir(),"kiln-recovery-lock-test-"));initHome(home,{plugAndPlay:true});const run=createRun(home,"offline synthetic case",{id:"lock-test"});
  expect(()=>assertRecoveryLock(run)).toThrow();const lock=acquireRunLock(run);
  try{expect(assertRecoveryLock(run).pid).toBe(process.pid);expect(()=>acquireRunLock(run)).toThrow();const claim=join(home,"execution.json");claimExecution(claim,{once:true});expect(()=>claimExecution(claim,{twice:true})).toThrow();}finally{lock.release();}
  expect(()=>assertRecoveryLock(run)).toThrow();
});
test("closed active phases exclude the idle gap between recovery invocations",()=>{
  const events:any[]=[{t:"phase.start",phase:"frame",ts:"2026-09-13T23:15:09.138Z"},{t:"phase.end",phase:"frame",ts:"2026-09-13T23:16:34.979Z"},{t:"phase.start",phase:"discover",ts:"2026-09-13T23:16:34.982Z"},{t:"phase.end",phase:"discover",ts:"2026-09-13T23:20:09.158Z"}];
  const elapsed=elapsedByPhase(events,Date.parse("2026-09-20T00:00:00Z"));expect((elapsed.frame??0)+(elapsed.discover??0)).toBeCloseTo(300.017,8);
});
test("native unchanged-target cached resume owns its lock before wake and provider calls",async()=>{
  for(const validCache of [true,false]){
    const home=mkdtempSync(join(tmpdir(),"kiln-recovery-native-test-"));initHome(home,{plugAndPlay:true});
    const original=defaultConfig();original.budgets.usd=25;original.budgets.wallSeconds=1500;original.routing={mode:"adaptive"};saveConfig(home,original);
    const run=createRun(home,QUALIFICATION_TASK,{id:"cached-resume"}),workflow=ensureWorkflowPlan(run,{adaptive:true});
    const execution=compileWorkflow(workflow,{through:"checkpoint",autonomous:true});
    const planned=planAdaptiveRouting(applyWorkflowProfile(original,workflow),new Set(["anthropic"]),QUALIFICATION_TASK,new Date(),undefined,{phases:execution.phases});freezeRouting(run,planned.config,planned.report);
    const questions=["alpha","beta","gamma","delta"],brief=`## Shape\nproduct\n\n## Discovery questions\n${questions.map(q=>`- ${q}`).join("\n")}\n`;writeFileSync(run.brief,brief);
    for(const [index,question]of questions.entries()){
      const metadata={fingerprint:createHash("sha256").update(JSON.stringify({brief,question})).digest("hex"),state:validCache||index>0?"ok":"failure",policyVersion:2,...(!validCache&&index===0?{failure:{class:"budget",message:"synthetic missing evidence"},budgetTargetUsd:25}:{})};
      writeFileSync(join(run.discoveryDir,`${index+1}-${question}.md`),`<!-- kiln-scout-v1:${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->\n# Question\n${question}\n\n# Findings\nSynthetic cached evidence for offline route testing.\n`);
    }
    const old=[{seq:1,t:"phase.start",phase:"frame",ts:"2026-01-01T00:00:00Z"},{seq:2,t:"phase.end",phase:"frame",outcome:"ok",ts:"2026-01-01T00:01:25Z"},{seq:3,t:"phase.start",phase:"discover",ts:"2026-01-01T00:01:25Z"},{seq:4,t:"phase.end",phase:"discover",outcome:"stopped",ts:"2026-01-01T00:05:00Z"}].map(e=>JSON.stringify(e)).join("\n")+"\n";writeFileSync(run.record,old);
    writeStatus(run,{phase:"discover",state:"stopped",routingRequired:true,outcome:{kind:"stopped",stopKind:"deadline",wallTargetSeconds:1500}});
    let onRun=0,providerCalls=0;const errors:string[]=[];
    const code=await main(["run","resume",run.id,"--home",home,"--through","checkpoint","--autonomous","--yes","--json"],{write:()=>{},error:s=>errors.push(s)},{apiKeyFor:async provider=>provider==="anthropic"?"offline-mock":undefined,streamFn:()=>{providerCalls++;throw new Error("unexpected provider dispatch");},onRun:active=>{
      expect(assertRecoveryLock(active).pid).toBe(process.pid);expect(readStatus(active).state).toBe("stopped");expect(readFileSync(active.record,"utf8")).toBe(old);onRun++;throw new Error("locked recovery preflight complete");
    }});
    expect(providerCalls).toBe(0);expect(onRun).toBe(validCache?1:0);expect(loadConfig(home).budgets.usd).toBe(25);expect(loadConfig(home).budgets.wallSeconds).toBe(1500);
    if(validCache){expect(code).not.toBe(0);expect(errors.join("")).toContain("locked recovery preflight complete");}
  }
});
const zero={input:0,output:0,cacheRead:0,cacheWrite:0};
test("queued undispatched aborts are zero-charge attempts, not missing provider-call records",()=>{
  const attempt={request:23,model:"anthropic/claude-fable-5-1",inputHash:"input",dispatched:false,stop:"aborted",usage:zero,costUsd:0,chargedUsd:0};
  expect(reconcileRecordedCalls([attempt],[])).toMatchObject({ok:true,createdStreams:1,dispatchedRequests:0,recordedCalls:0});
  expect(reconcileRecordedCalls([attempt],[]).undispatchedAttempts).toHaveLength(1);
  const synthetic={seq:138,provider:"anthropic",model:"claude-fable-5-1",inputHash:"input",stopReason:"error",usage:zero,costUsd:0};
  expect(reconcileRecordedCalls([{...attempt,stop:"error"}],[synthetic]).ok).toBe(true);
  expect(reconcileRecordedCalls([{...attempt,stop:"error"}],[{...synthetic,costUsd:.2}]).ok).toBe(false);
});
test("canonical partial-abort usage and absent zero-usage aborts remain fully reserved",()=>{
  const attempt={request:23,model:"anthropic/claude-fable-5-1",inputHash:"input",dispatched:true,stop:"aborted",usage:zero,costUsd:0,chargedUsd:3,reserveUsd:3};
  const partial={seq:138,provider:"anthropic",model:"claude-fable-5-1",inputHash:"input",stopReason:"aborted",usage:{...zero,input:10,output:2},costUsd:.08};
  expect(reconcileRecordedCalls([attempt],[partial]).ok).toBe(true);expect(reconcileRecordedCalls([attempt],[]).ok).toBe(true);
  expect(reconcileRecordedCalls([{...attempt,chargedUsd:0}],[]).ok).toBe(false);
  expect(reconcileRecordedCalls([attempt],[{...partial,costUsd:4}]).ok).toBe(false);
});
test("owned successful calls must match canonical model, input hash, usage and cost",()=>{
  const usage={...zero,input:10,output:20},attempt={request:23,model:"anthropic/claude-fable-5-1",inputHash:"input",dispatched:true,stop:"toolUse",usage,costUsd:.12,chargedUsd:.12};
  const row={seq:138,provider:"anthropic",model:"claude-fable-5-1",inputHash:"input",stopReason:"toolUse",usage,costUsd:.12};
  expect(reconcileRecordedCalls([attempt],[row]).ok).toBe(true);expect(reconcileRecordedCalls([attempt],[]).ok).toBe(false);
  expect(reconcileRecordedCalls([attempt],[{...row,inputHash:"foreign"}]).ok).toBe(false);
  expect(reconcileRecordedCalls([attempt],[{...row,usage:{...usage,output:21}}]).ok).toBe(false);
  expect(reconcileRecordedCalls([attempt],[row,row]).ok).toBe(false);
});
function cancellationFixture(){
  const before=Buffer.from(JSON.stringify({seq:1,ts:"2026-01-01T00:00:00.000Z",t:"phase.start",phase:"discover"})+"\n");
  const receipt={at:"2026-01-01T00:00:02.000Z",history:{bytes:before.length,sha256:createHash("sha256").update(before).digest("hex"),lastSequence:1,openPhases:["discover"],costUsd:1.25}};
  const tail=[{seq:2,ts:"2026-01-01T00:00:03.000Z",t:"phase.end",phase:"discover",outcome:"cancelled"},{seq:3,ts:"2026-01-01T00:00:03.001Z",t:"note",text:"operator cancelled the active step; resume from the saved boundary"}];
  const encode=(rows:any[])=>Buffer.concat([before,Buffer.from(rows.map(r=>JSON.stringify(r)).join("\n")+"\n")]);
  return {before,receipt,tail,encode,status:{state:"paused",pausedReason:"user_cancelled",usdSpent:1.25},now:Date.parse("2026-01-01T00:00:05Z")};
}
test("only exact native cancellation closure may extend a locked receipt",()=>{
  const f=cancellationFixture();expect(verifyFinalJournal(f.before,f.receipt,false,f.status,f.now).ok).toBe(true);
  expect(verifyFinalJournal(f.encode(f.tail),f.receipt,true,f.status,f.now)).toMatchObject({ok:true,kind:"native-controller-cancellation-suffix",events:2});
  expect(verifyFinalJournal(f.encode(f.tail),f.receipt,false,f.status,f.now).ok).toBe(false);
  expect(verifyFinalJournal(f.encode(f.tail),f.receipt,true,{...f.status,usdSpent:2},f.now).ok).toBe(false);
  expect(verifyFinalJournal(f.encode(f.tail),f.receipt,true,{...f.status,state:"running"},f.now).ok).toBe(false);
});
test("extra, altered, stale or torn post-receipt events cannot masquerade as cancellation",()=>{
  const f=cancellationFixture();
  const variants=[
    [{...f.tail[0],phase:"build"},f.tail[1]],
    [{...f.tail[0],seq:9},f.tail[1]],
    [{...f.tail[0],extra:"unowned"},f.tail[1]],
    [{...f.tail[0],ts:"2025-01-01T00:00:00.000Z"},f.tail[1]],
    [f.tail[0],{...f.tail[1],text:"different note"}],
    [...f.tail,{seq:4,ts:"2026-01-01T00:00:04.000Z",t:"model.call"}],
  ];
  for(const rows of variants)expect(verifyFinalJournal(f.encode(rows),f.receipt,true,f.status,f.now).ok).toBe(false);
  const torn=f.encode(f.tail);expect(verifyFinalJournal(torn.subarray(0,torn.length-1),f.receipt,true,f.status,f.now).ok).toBe(false);
  const mutated=Buffer.from(f.encode(f.tail));mutated[0]=0;expect(verifyFinalJournal(mutated,f.receipt,true,f.status,f.now).ok).toBe(false);
});
