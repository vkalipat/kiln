import { test, expect } from "bun:test";
import { completionEvidence, assertNativePlan, QUALIFICATION_TASK, CAP_USD, PLANNING_TARGET_USD, validCap, claimExecution, FifoBudget, QualificationBudgetExhausted } from "../../scripts/benchmarks/adaptive-ideation-validation";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initHome } from "../../src/core/home";
import { createRun } from "../../src/core/run";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { main } from "../../src/cli/main";
import { seedIdentityFromSplit } from "../../src/evals/identity";
test("business diagnostic task is not a canonical heldout task",()=>{
  const split=JSON.parse(readFileSync(join(import.meta.dir,"../..","evals/split.json"),"utf8"));
  expect(seedIdentityFromSplit(QUALIFICATION_TASK,split)).toBeUndefined();
  expect(CAP_USD).toBe(14);expect(PLANNING_TARGET_USD).toBe(25);
});
function completedFixture(){
  const ids=["a","b","c","d"],shown=ids.slice(0,3),strengths={value:{n:3},feasibility:{n:3}};
  const frontier={version:1,round:1,shown,rawFront:shown,eligible:ids,ideas:ids.map(id=>({id,...strengths})),searchHealth:1,searchHealthFloor:.8,noveltyEnforced:true};
  const events=[{t:"checkpoint.shown",round:1,ideas:shown},{t:"checkpoint.decision",kind:"autonomous_pick",id:"a"}];
  const tournament:any[]=[];for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)for(const order of ["ab","ba"])tournament.push({round:1,a:ids[i],b:ids[j],order,source:"judge",criteriaId:"criteria",valueWinner:"a",feasibilityWinner:"b"});
  const audit={cancelled:false,sourceUnchanged:true,status:{state:"running",phase:"form",chosenIdeaId:"a"},tournament,evidenceByIdea:Object.fromEntries(ids.map(id=>[id,{status:"active",renderPresent:true,strengths,priorArt:{status:"not_falsified"},probe:{status:"not_run"}}]))};
  return {frontier,events,audit};
}
test("exit zero and arbitrary frontier or mismatched pick cannot claim checkpoint",()=>{
  expect(completionEvidence([],0,{}).checkpointDelivered).toBe(false);
  const {events,frontier,audit}=completedFixture();
  expect(completionEvidence(events,1,frontier,audit).checkpointDelivered).toBe(false);
  expect(completionEvidence(events,0,{},audit).checkpointDelivered).toBe(false);
  events[1]!.id="outsider";expect(completionEvidence(events,0,frontier,audit).checkpointDelivered).toBe(false);
});
test("task review readiness requires three ideas and complete comparisons without claiming validation",()=>{
  const {events,frontier,audit}=completedFixture();
  expect(completionEvidence(events,0,frontier,audit)).toMatchObject({checkpointDelivered:true,taskReadyForReview:true,qualityScore:null,manualSourceAudit:"pending"});
  const fewer=structuredClone(events);fewer[0]!.ideas=["a","a","b"];
  expect(completionEvidence(fewer,0,frontier,audit).taskReadyForReview).toBe(false);
  expect(completionEvidence(events,0,frontier,{...audit,tournament:audit.tournament.slice(1)}).taskReadyForReview).toBe(false);
  expect(completionEvidence(events,0,frontier,{...audit,cancelled:true}).checkpointDelivered).toBe(false);
  expect(completionEvidence(events,0,frontier,{...audit,sourceUnchanged:false}).checkpointDelivered).toBe(false);
});
test("degraded search remains prominent even with a mechanically delivered checkpoint",()=>{
  const {events,frontier,audit}=completedFixture();frontier.noveltyEnforced=false;
  const result=completionEvidence(events,0,frontier,audit);
  expect(result.checkpointDelivered).toBe(true);expect(result.taskReadyForReview).toBe(false);expect(result.searchDegraded).toBe(true);
  expect(result.shownEvidence[0]).toMatchObject({completeAbBaOpponents:3,priorArtStatus:"not_falsified",probeStatus:"not_run"});
  expect(result.warnings.length).toBeGreaterThan(0);
});
test("caps are finite numeric and execution claim is exclusive",()=>{
  for(const value of [undefined,null,"14",NaN,Infinity,0,-1,14.01])expect(validCap(value)).toBe(false);
  expect(validCap(14)).toBe(true);expect(validCap(25)).toBe(false);
  const dir=mkdtempSync(join(tmpdir(),"kiln-exclusive-claim-test-")),path=join(dir,"execution.json");claimExecution(path,{first:true});
  expect(()=>claimExecution(path,{second:true})).toThrow();expect(JSON.parse(readFileSync(path,"utf8"))).toEqual({first:true});
});
test("manual run cannot pass native adaptive freeze assertion",()=>{
  const home=mkdtempSync(join(tmpdir(),"kiln-native-assert-test-"));initHome(home,{plugAndPlay:true});
  const run=createRun(home,"benign conceptual task",{id:"manual"});expect(()=>assertNativePlan(run)).toThrow("native adaptive");
});
test("real CLI freezes adaptive ideation before the first provider dispatch",async()=>{
  const home=mkdtempSync(join(tmpdir(),"kiln-native-cli-test-"));initHome(home,{plugAndPlay:true});
  const cfg=defaultConfig();cfg.routing={mode:"adaptive"};cfg.budgets.usd=PLANNING_TARGET_USD;cfg.budgets.wallSeconds=1500;
  for(const role of Object.keys(cfg.roles) as Array<keyof typeof cfg.roles>)cfg.effortByRole![role]="xhigh";
  saveConfig(home,cfg);
  const seed=QUALIFICATION_TASK;
  let calls=0,verified=false;const errors:string[]=[];
  const code=await main(["run","new",seed,"--id","preflight","--home",home,"--through","checkpoint","--autonomous","--yes","--json"],{write:()=>{},error:t=>errors.push(t)},{
    apiKeyFor:async(provider)=>provider==="anthropic"?"mock-test-credential":undefined,
    streamFn:()=>{calls++;throw new Error("unexpected paid dispatch");},
    onRun:run=>{const plan=assertNativePlan(run);expect(plan.execution.phases).toContain("checkpoint");expect(plan.routing.ideationProfile?.entrantsCap).toBe(8);expect(plan.routing.ideationProfile?.islands).toBe(2);verified=true;throw new Error("offline preflight complete");}
  });
  expect(errors.join("")).toContain("offline preflight complete");expect(verified).toBe(true);expect(calls).toBe(0);expect(code).not.toBe(0);
});
test("parallel wire requests wait for reservations to settle without cancelling active work",async()=>{
  const charges:number[]=[],gate=new FifoBudget(10,()=>charges.push(gate.chargedUsd));
  const dispatched:number[]=[];
  const fakeRequest=(id:number)=>gate.acquire(4).then(ticket=>{dispatched.push(id);return ticket;});
  const one=fakeRequest(1),two=fakeRequest(2),three=fakeRequest(3),four=fakeRequest(4);
  const a=await one,b=await two;
  expect(dispatched).toEqual([1,2]);expect(gate.queuedCount).toBe(2);expect(gate.chargedUsd).toBe(8);
  a.settle(.5,"stop");const c=await three;expect(dispatched).toEqual([1,2,3]);expect(gate.queuedCount).toBe(1);
  b.settle(.5,"stop");const d=await four;expect(dispatched).toEqual([1,2,3,4]);
  c.settle(.5,"stop");d.settle(.5,"stop");expect(gate.chargedUsd).toBe(2);expect(gate.activeCount).toBe(0);
  expect(Math.max(...charges)).toBeLessThanOrEqual(10);
});
test("FIFO prevents smaller requests from overtaking a temporarily blocked head",async()=>{
  const gate=new FifoBudget(10),first=await gate.acquire(8),order:string[]=[];
  const head=gate.acquire(7).then(t=>{order.push("head");return t;}),tail=gate.acquire(2).then(t=>{order.push("tail");return t;});
  await Promise.resolve();expect(order).toEqual([]);expect(gate.queuedCount).toBe(2);
  first.settle(1,"stop");const [a,b]=await Promise.all([head,tail]);expect(order).toEqual(["head","tail"]);expect(gate.chargedUsd).toBe(10);
  a.settle(1,"stop");b.settle(1,"stop");expect(gate.chargedUsd).toBe(3);
});
test("permanent insufficiency rejects before dispatch and retains settled exposure",async()=>{
  const gate=new FifoBudget(10),ticket=await gate.acquire(8);ticket.settle(8,"stop");let dispatches=0;
  const failure=await gate.acquire(3).then(()=>{dispatches++;return null;},e=>e);
  expect(failure).toBeInstanceOf(QualificationBudgetExhausted);expect(dispatches).toBe(0);expect(gate.chargedUsd).toBe(8);expect(gate.queuedCount).toBe(0);
  await expect(new FifoBudget(10).acquire(11)).rejects.toBeInstanceOf(QualificationBudgetExhausted);
});
test("queued deadline cancellation is zero-charge and does not disturb active work",async()=>{
  const gate=new FifoBudget(10),active=await gate.acquire(8),cancel=new AbortController();let dispatches=0;
  const pending=gate.acquire(5,cancel.signal).then(()=>{dispatches++;return null;},e=>e);
  const deadline=new Error("fake queued deadline");cancel.abort(deadline);
  expect(await pending).toBe(deadline);expect(dispatches).toBe(0);expect(gate.queuedCount).toBe(0);expect(gate.activeCount).toBe(1);expect(gate.chargedUsd).toBe(8);
  active.settle(1,"stop");expect(gate.chargedUsd).toBe(1);
  await expect(gate.acquire(1,cancel.signal)).rejects.toBe(deadline);expect(gate.chargedUsd).toBe(1);
});
test("dispatched error keeps its reserve and wakes permanently unaffordable queued work",async()=>{
  for(const stop of ["error","aborted"]){
    const gate=new FifoBudget(10),active=await gate.acquire(8);let dispatches=0;
    const waiting=gate.acquire(3).then(()=>{dispatches++;return null;},e=>e);
    expect(gate.queuedCount).toBe(1);expect(active.settle(.5,stop)).toBe(8);
    expect(await waiting).toBeInstanceOf(QualificationBudgetExhausted);expect(dispatches).toBe(0);expect(gate.chargedUsd).toBe(8);expect(gate.activeCount).toBe(0);
    active.settle(0,"not_dispatched");expect(gate.chargedUsd).toBe(8); // Idempotence prevents accidental reserve reset.
  }
});
test("cancellation immediately after admission releases undispatched reservation once",async()=>{
  const gate=new FifoBudget(10),ticket=await gate.acquire(8);expect(gate.chargedUsd).toBe(8);
  ticket.settle(0,"not_dispatched");expect(gate.chargedUsd).toBe(0);expect(gate.activeCount).toBe(0);
  ticket.settle(0,"aborted");expect(gate.chargedUsd).toBe(0);
});
test("fourteen-dollar guard stays separate from twenty-five-dollar native planning",async()=>{
  const gate=new FifoBudget(CAP_USD),first=await gate.acquire(10);let dispatched=false;
  const next=gate.acquire(5).then(t=>{dispatched=true;return t;});await Promise.resolve();expect(dispatched).toBe(false);expect(gate.chargedUsd).toBe(10);
  first.settle(2,"stop");const second=await next;expect(dispatched).toBe(true);expect(gate.chargedUsd).toBe(7);second.settle(2,"stop");expect(gate.chargedUsd).toBe(4);
  await expect(gate.acquire(PLANNING_TARGET_USD)).rejects.toBeInstanceOf(QualificationBudgetExhausted);expect(gate.chargedUsd).toBe(4);
});
