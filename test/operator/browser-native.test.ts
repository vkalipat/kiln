import { expect, test } from "bun:test";
import { buildBrowserWorkflowScript, runNativeBrowserWorkflow } from "../../src/operator/browser-native";
import { buildBrowserDecisionQuestions, decodeBrowserDecision, type BrowserTaskInput } from "../../src/operator/browser-workflow";
const input: BrowserTaskInput={tab:"fixture",task:"Read fixture",checks:[{kind:"text_includes",value:"ready"}],allowedActions:[]};
const snapshot={url:"https://example.test/",title:"Fixture",text:"pending",actions:[],marker:[1],page_key:[],guards:{}};
test("generated native controller uses host decision and independent checks",async()=>{
 const calls:string[]=[];
 const tab={evaluate:async(code:string)=>{calls.push(code);return code.includes('checks.map')?{checks:[{index:0,kind:"text_includes",passed:true}],observation:snapshot}:snapshot;}};
 const tool={kiln_browser_decide:async(payload:any)=>({details:{accepted:true,stateHash:payload.stateHash,operation:"done"}})};
 const execute=new Function("tab","tool","wait",`return ${buildBrowserWorkflowScript(input)}`);
 const result=await execute(tab,tool,async()=>{});
 expect(result.status).toBe("verified");expect(result.taskQualityValidated).toBe(false);expect(result.finalObservation.text).toBe("pending");expect(calls.length).toBe(2);
});
test("native controller refuses eval bridge reentrancy before looking up tabs",async()=>{
 const result=await runNativeBrowserWorkflow({ctx:{} as any,input,toolCallId:"js-browser_task-fixture"});expect(result.status).toBe("unsupported");expect(result.reason).toContain("directly");
});
test("decision fusion uses only operation and selected target acceptance",()=>{
 const payload={task:input.task,stateHash:"hash",step:0,state:{...snapshot,actions:[{id:"e1",kind:"click" as const,label:"Next"}]}};
 expect(buildBrowserDecisionQuestions(payload).questions.click_target?.criteria.e1).toBe("Next");
 const answer=(choice:string,accepted=true)=>({choice,accepted,confidence:1,probabilities:{[choice]:1}});
 expect(decodeBrowserDecision(payload,{reason:"low_confidence",answers:{operation:answer("click"),click_target:answer("e1"),unused:answer("x",false)}}).accepted).toBe(true);
 expect(decodeBrowserDecision(payload,{reason:"low_confidence",answers:{operation:answer("click"),click_target:answer("e1",false)}}).accepted).toBe(false);
});

test("native DOM guard tolerates transport key ordering without accepting changed meaning",async()=>{
 const {browserGuardScript}=await import("../../src/operator/browser-observation");
 const before={...snapshot,marker:[{node:1,label:"Next",kind:"click"}]};
 const fresh={...snapshot,marker:[{kind:"click",label:"Next",node:1}]};
 const script=browserGuardScript("cache","observed",{kind:"scroll"},before,"token");
 const evaluate=new Function("window","observed",`return ${script}`);
 expect(evaluate({cache:{}},fresh)).toBe("ready");
 expect(evaluate({cache:{}},{...fresh,marker:[{kind:"click",label:"Delete",node:1}]})).toBe("stale");
});

test("acquired native run validates original lease before reading a replacement tab",async()=>{
 let observations=0;
 const execute=new Function("tab","tool","wait",`return ${buildBrowserWorkflowScript(input,undefined,undefined,{tab:"fixture",ownerSessionId:"owner",targetId:"original",token:"fixture-token"})}`);
 const result=await execute({evaluate:async()=>{observations++;return snapshot;}},{kiln_browser_guard:async()=>({details:{valid:false}})},async()=>{});
 expect(result.status).toBe("unsupported");expect(observations).toBe(0);expect(result.decisions).toBe(0);
});

test("final checks and evidence use one snapshot even when the page changes on the next read",async()=>{
 const {browserVerificationScript}=await import("../../src/operator/browser-observation");
 let reads=0;
 const takeSnapshot=()=>({...snapshot,text:++reads===1?"ready":"changed after verification"});
 const evaluate=new Function("takeSnapshot",`return ${browserVerificationScript("takeSnapshot()",input.checks)}`);
 const receipt=evaluate(takeSnapshot);
 expect(reads).toBe(1);expect(receipt.checks[0].passed).toBe(true);expect(receipt.observation.text).toBe("ready");
 expect(takeSnapshot().text).toBe("changed after verification");expect(receipt.observation.text).toBe("ready");
});

test("proven pre-input stale guard reobserves and redecides within the original budget",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");
 let reads=0,attempts=0,dispatched=0;const seen:string[]=[];
 const result=await runBrowserWorkflow({...input,allowedActions:[{kind:"click",label:"Next"}],maxDecisions:3},{
  now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,marker:[++reads],actions:[{id:`e${reads}`,kind:"click",label:"Next"}]}),
  decide:async p=>{seen.push(p.state.actions[0]!.id);return {accepted:true,stateHash:p.stateHash,operation:p.step===2?"done":"click",target:p.state.actions[0]!.id};},
  act:async()=>{if(++attempts===1)return {status:"stale",inputDispatched:false};dispatched++;return {status:"acted"};},
  verify:async()=>({checks:[{index:0,kind:"text_includes",passed:true}],observation:snapshot})
 });
 expect(result.status).toBe("verified");expect(result.decisions).toBe(3);expect(result.actions).toBe(1);expect(dispatched).toBe(1);expect(seen).toEqual(["e1","e2","e3"]);
});

test("unproven stale and uncertain dispatch never receive an automatic retry",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");
 for(const mode of ["stale","throw"]){let attempts=0,reads=0;
  const result=await runBrowserWorkflow({...input,allowedActions:[{kind:"click",label:"Next"}]},{now:()=>0,wait:async()=>{},observe:async()=>{reads++;return {...snapshot,actions:[{id:"e1",kind:"click",label:"Next"}]};},decide:async p=>({accepted:true,stateHash:p.stateHash,operation:"click",target:"e1"}),act:async()=>{attempts++;if(mode==="throw")throw new Error("Lost acknowledgement");return {status:"stale"};},verify:async()=>{throw new Error("Not reached");}});
  expect(result.status).toBe(mode==="throw"?"ambiguous":"stale");expect(attempts).toBe(1);expect(reads).toBe(1);
 }
});

test("proven stale recovery stops at the original decision ceiling",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let attempts=0;
 const result=await runBrowserWorkflow({...input,allowedActions:[{kind:"click",label:"Next"}],maxDecisions:2},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,actions:[{id:"e1",kind:"click",label:"Next"}]}),decide:async p=>({accepted:true,stateHash:p.stateHash,operation:"click",target:"e1"}),act:async()=>{attempts++;return {status:"stale",inputDispatched:false};},verify:async()=>{throw new Error("Not reached");}});
 expect(result.status).toBe("stale");expect(result.decisions).toBe(2);expect(attempts).toBe(2);expect(result.actions).toBe(0);
});

test("atomic final verification rejects an incomplete control table",async()=>{
 const {browserVerificationScript}=await import("../../src/operator/browser-observation");
 const evaluate=new Function("observed",`return ${browserVerificationScript("observed",[{kind:"field_equals",label:"Name",value:"Fixture"}])}`);
 expect(()=>evaluate({...snapshot,omitted_actions:1,actions:[{kind:"fill",label:"Name",value:"Fixture"}]})).toThrow("Fresh verification unavailable");
});

test("already satisfied literal fields are omitted and cannot execute forged selections",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let acts=0;
 const result=await runBrowserWorkflow({...input,values:{Name:"Fixture"},allowedActions:[{kind:"fill",label:"Name"}]},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,actions:[{id:"e1",kind:"fill",label:"Name",value:"Fixture"}]}),decide:async p=>{expect(p.state.actions).toEqual([]);expect(p.state.fields).toEqual([{label:"Name",value:"Fixture"}]);return {accepted:true,stateHash:p.stateHash,operation:"type_text",target:"e1"};},act:async()=>{acts++;return {status:"acted"};},verify:async()=>[]});
 expect(result.status).toBe("unsupported");expect(acts).toBe(0);
});

test("freshly completed fill disappears on the next decision while raw guard evidence survives",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let value="",acts=0;
 const result=await runBrowserWorkflow({...input,values:{Name:"Fixture"},allowedActions:[{kind:"fill",label:"Name"}],maxDecisions:2},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,actions:[{id:"e1",kind:"fill",label:"Name",value}]}),decide:async p=>{expect(p.state.actions.length).toBe(p.step===0?1:0);expect(p.state.fields).toEqual([{label:"Name",value:p.step===0?"":"Fixture"}]);return {accepted:true,stateHash:p.stateHash,operation:p.step===0?"type_text":"done",target:"e1"};},act:async(_action,raw,literal)=>{expect(raw.actions[0]?.value).toBe("");value=literal!;acts++;return {status:"acted"};},verify:async()=>({checks:[{index:0,kind:"text_includes",passed:value==="Fixture"}],observation:snapshot})});
 expect(result.status).toBe("verified");expect(acts).toBe(1);
});

test("missing observed value is not mistaken for satisfied and absent literal never dispatches",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");
 for(const values of [undefined,{Name:"Fixture"}]){let acts=0;
 const result=await runBrowserWorkflow({...input,values,allowedActions:[{kind:"fill",label:"Name"}],maxDecisions:1},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,actions:[{id:"e1",kind:"fill",label:"Name"}]}),decide:async p=>{expect(p.state.actions).toHaveLength(1);expect(p.state.fields).toEqual([]);return {accepted:true,stateHash:p.stateHash,operation:"type_text",target:"e1"};},act:async()=>{acts++;return {status:"stale"};},verify:async()=>[]});
 expect(acts).toBe(values?1:0);expect(result.status).toBe(values?"stale":"unsupported");}
});

test("inherited field literals are not admitted",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let reads=0;
 await expect(runBrowserWorkflow({...input,values:Object.create({Name:"Fixture"}),allowedActions:[{kind:"fill",label:"Name"}]},{now:()=>0,wait:async()=>{},observe:async()=>{reads++;return snapshot;},decide:async()=>{throw new Error("Not reached");},act:async()=>({status:"acted"}),verify:async()=>[]})).rejects.toThrow("Invalid literal field values");
 expect(reads).toBe(0);
});

test("all decision heads share authorized task and exact checks without losing observed evidence",()=>{
 const payload={task:"Fill field and preview greeting",checks:[{kind:"text_includes" as const,value:"Hello Fixture"}],stateHash:"hash",step:1,state:{...snapshot,fields:[{label:"Name",value:"Fixture"}],actions:[{id:"e1",kind:"click" as const,label:"Preview"}]}};
 const batch=buildBrowserDecisionQuestions(payload);
 expect(batch.state).toMatchObject({task:payload.task,checks:payload.checks,fields:payload.state.fields});
 expect(batch.questions.click_target?.instructions).toContain("state.task");expect(batch.questions.click_target?.instructions).toContain("state.checks");
 expect(batch.questions.operation?.criteria.click).toContain("authorized task");
 expect(()=>buildBrowserDecisionQuestions({...payload,checks:Array(9).fill(payload.checks[0])})).toThrow();
 expect(()=>buildBrowserDecisionQuestions({...payload,checks:[{kind:"text_includes",value:"x".repeat(1001)}]})).toThrow();
 expect(buildBrowserDecisionQuestions({...payload,checks:undefined}).state).toMatchObject({task:payload.task});
});

test("completion candidates verify without a semantic done decision, including changed or cancelled verification",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");
 for(const mode of ["complete","changed","cancel"]){let decisions=0,verifications=0,acts=0;const abort=new AbortController();
 const result=await runBrowserWorkflow(input,{signal:abort.signal,now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,text:"ready"}),decide:async()=>{decisions++;throw new Error("Not reached");},act:async()=>{acts++;return {status:"acted"};},verify:async()=>{verifications++;if(mode==="cancel")abort.abort();return {checks:[{index:0,kind:"text_includes",passed:mode!=="changed"}],observation:{...snapshot,text:mode==="changed"?"changed":"ready"}};}});
 expect(result.status).toBe(mode==="complete"?"verified":mode==="cancel"?"cancelled":"incomplete");expect(decisions).toBe(0);expect(acts).toBe(0);expect(verifications).toBe(1);expect(result.taskQualityValidated).toBe(false);
 }
});

test("completion after two actions uses two decisions and an atomic verifier",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let acts=0,decisions=0,verifications=0;
 const result=await runBrowserWorkflow({...input,allowedActions:[{kind:"click",label:"Next"}],maxDecisions:3},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,text:acts===2?"ready":"pending",actions:[{id:"e1",kind:"click",label:"Next"}]}),decide:async p=>{decisions++;return {accepted:true,stateHash:p.stateHash,operation:"click",target:"e1"};},act:async()=>{acts++;return {status:"acted"};},verify:async()=>{verifications++;return {checks:[{index:0,kind:"text_includes",passed:true}],observation:{...snapshot,text:"ready"}};}});
 expect(result.status).toBe("verified");expect(decisions).toBe(2);expect(acts).toBe(2);expect(verifications).toBe(1);
});

test("duplicate matching fields cannot nominate completion",async()=>{
 const {runBrowserWorkflow}=await import("../../src/operator/browser-workflow");let verifications=0,decisions=0;
 const result=await runBrowserWorkflow({...input,checks:[{kind:"field_equals",label:"Name",value:"Fixture"}]},{now:()=>0,wait:async()=>{},observe:async()=>({...snapshot,actions:[{id:"e1",kind:"fill",label:"Name",value:"Fixture"},{id:"e2",kind:"fill",label:"Name",value:"Fixture"}]}),decide:async p=>{decisions++;return {accepted:false,stateHash:p.stateHash};},act:async()=>{throw new Error("Not reached");},verify:async()=>{verifications++;return [];}});
 expect(result.status).toBe("incomplete");expect(decisions).toBe(1);expect(verifications).toBe(0);
});
