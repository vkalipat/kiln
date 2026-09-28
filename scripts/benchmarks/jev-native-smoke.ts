/** Local owned cmux fixture. Default is provider-free. Explicit --live uses env TYPESAFE_API_KEY, at most 3 production Jev requests and $0.008064 admitted exposure. */
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockModel, streamMock } from '@oh-my-pi/pi-ai/providers/mock';
import { createOmpSession } from '../../src/operator/session';
import { runNativeBrowserWorkflow, buildBrowserWorkflowScript, validateNativeBrowserLease } from '../../src/operator/browser-native';
import { runBrowserWorkflow, type BrowserDecisionPayload } from '../../src/operator/browser-workflow';

import { createJevWorkflowService } from '../../src/operator/jev-service';
import { createOperatorMeter } from '../../src/operator/meter';
import { registerOperatorWorkflowTools } from '../../src/operator/workflow-tools';
const live=process.argv.includes('--live');
if(live&&!process.env.TYPESAFE_API_KEY)throw new Error('--live requires TYPESAFE_API_KEY in environment');
const controllerSource=runBrowserWorkflow.toString();
const verificationSource=controllerSource.slice(controllerSource.indexOf('verified = async'),controllerSource.indexOf('for (let step'));
if(!verificationSource.includes('port.verify(')||verificationSource.includes('port.observe('))throw new Error('Completion verification must not make a second observation RPC');
const root = mkdtempSync(join(tmpdir(), 'kiln-native-browser-smoke-'));
const name = `kiln-smoke-${Date.now()}`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(`<!doctype html><title>Kiln owned fixture</title><label>Name <input aria-label="Name" id="name"></label><button onclick="document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Preview</button><p id="result">Waiting</p>`, {headers:{'content-type':'text/html'}}); } });
const model = createMockModel({ id: 'native-browser-smoke' });
let decisions = 0;
const lifetime=new AbortController();
const meter=createOperatorMeter({run:{id:'native-smoke',dir:root},limitUsd:0.008064,onViolation:error=>lifetime.abort(error)});
const service=createJevWorkflowService({enabled:live,apiKey:live?process.env.TYPESAFE_API_KEY:undefined,maxCalls:3,maxInputTokens:192000,signal:()=>lifetime.signal,reserve:request=>meter.reserveExternal(request),onStats:()=>{}});

const decisionDiagnostics: unknown[]=[];
const measuredService={...service,async evaluate(request:Parameters<typeof service.evaluate>[0]){
 const result=await service.evaluate(request);
 // This benchmark submits only its controlled localhost fixture. Never include credentials or request headers.
 decisionDiagnostics.push({state:request.state,questions:request.questions,reason:result.reason,answers:result.answers,source:result.source});
 return result;
}};
const handle = await createOmpSession({ cwd: root, stateDir: join(root,'state'), model: model as never, modelRef: `${model.provider}/${model.id}`, effort:'low', connectedProviders:[model.provider], auth:{apiKeyFor:async()=> 'synthetic',configuredProviders:p=>[...p]},streamFn:streamMock as never,contextFiles:[], extensions:[api=>{if(live){
registerOperatorWorkflowTools({...api,registerTool(tool){if(!['kiln_browser_guard','kiln_browser_decide'].includes(tool.name))return; const execute=tool.execute;api.registerTool({...tool,async execute(...args){if(tool.name==='kiln_browser_decide')decisions++;return execute(...args);}});}}, {enabled:true,jev:measuredService,signal:()=>lifetime.signal,assertOriginal(){},admit:()=>()=>{},toolContext:{} as never,artifactDir:root,browser:(input,execution)=>runNativeBrowserWorkflow({...execution,input}),onStatus(){},onReceipt:async()=>{throw new Error('Unused fixture receipt path');}});return;
}api.registerTool({name:'kiln_browser_guard',label:'Native lease guard',description:'Validate actual native lease',parameters:api.zod.any(),async execute(_id,payload,_signal,_update,ctx){return {content:[],details:{valid:await validateNativeBrowserLease(payload.nativeLease,ctx.sessionManager.getSessionId())}};}});api.registerTool({name:'kiln_browser_decide',label:'Fixture decision',description:'Local deterministic fixture only',parameters:api.zod.any(),async execute(_id,payload:BrowserDecisionPayload & {nativeLease?:Parameters<typeof validateNativeBrowserLease>[0]},_signal,_update,ctx){if(!await validateNativeBrowserLease(payload.nativeLease,ctx.sessionManager.getSessionId()))throw new Error('Invalid native decision lease');decisions++;const kind=payload.step===0?'fill':payload.step===1?'click':undefined;const action=payload.state.actions.find(a=>a.kind===kind && a.label===(kind==='fill'?'Name':'Preview'));return {content:[{type:'text',text:'fixture'}],details:{accepted:true,stateHash:payload.stateHash,operation:kind==='fill'?'type_text':kind??'done',target:action?.id}};}});}] });
const executor=handle.session.getToolForEvalBridge('eval')!;
async function cell(code:string){const r=await executor.execute('native-smoke-'+crypto.randomUUID(),{language:'js',code,timeout:25}); if(r.isError)throw new Error(JSON.stringify(r));return r;}
let opened=false;
try {
 await cell(`await browser.open({name:${JSON.stringify(name)},url:${JSON.stringify(server.url.href)}}); display('owned-tab-opened')`);opened=true;
 const input={tab:name,task:'Fill Name with Fixture and preview greeting',checks:[{kind:'text_includes' as const,value:'Hello Fixture'}],allowedActions:[{kind:'fill' as const,label:'Name'},{kind:'click' as const,label:'Preview'}],values:{Name:'Fixture'},maxDecisions:3,timeoutMs:25000};
 const cacheKey='__kiln_smoke_rejected';
 const invalidScript=buildBrowserWorkflowScript(input,undefined,cacheKey,{tab:name,ownerSessionId:handle.sessionId,targetId:'invalid',token:'invalid'});
 const rejected=await cell(`display(await browser.tab(${JSON.stringify(name)}).run(${JSON.stringify(invalidScript)}))`);
 const untouched=await cell(`display(await browser.tab(${JSON.stringify(name)}).run(${JSON.stringify(`await tab.evaluate(() => ({observed:Object.hasOwn(window,${JSON.stringify(cacheKey)}),value:document.querySelector('#name').value}));`)}))`);
 const rejectedProof=(rejected.details as {jsonOutputs?:Array<{status:string;decisions:number;actions:number}>}).jsonOutputs?.[0];
 const untouchedProof=(untouched.details as {jsonOutputs?:Array<{observed:boolean;value:string}>}).jsonOutputs?.[0];
 if(rejectedProof?.status!=='unsupported'||rejectedProof.decisions!==0||rejectedProof.actions!==0||untouchedProof?.observed!==false||untouchedProof.value!==''||decisions!==0)throw new Error('Invalid lease observed or mutated page');
 const result=await runNativeBrowserWorkflow({ctx:{sessionManager:handle.session.sessionManager} as never,input,toolCallId:'smoke-direct'});
 const independent=await cell(`display(await browser.tab(${JSON.stringify(name)}).run("await tab.evaluate(() => ({value:document.querySelector('#name').value,result:document.querySelector('#result').textContent}));"))`);
 const controller=new AbortController();controller.abort();
 const cancelled=await runNativeBrowserWorkflow({ctx:{sessionManager:handle.session.sessionManager} as never,input,toolCallId:'smoke-cancel',signal:controller.signal});
 writeSync(1, JSON.stringify({mode:live?"live":"offline",decisionDiagnostics,jev:service.stats(),meter:meter.usage(),atomicCompletion:{verificationCalls:1,extraObservationCalls:0,evidence:"controller source assertion"},invalidLease:{status:rejectedProof.status,observed:untouchedProof.observed,value:untouchedProof.value},result,independent:(independent.details as {jsonOutputs?:unknown[]}).jsonOutputs,decisions,modelCalls:model.calls.length,cancelled:cancelled.status},null,2)+"\n");
 const proof=(independent.details as {jsonOutputs?:Array<{value:string;result:string}>}).jsonOutputs?.[0];
 if(result.finalObservation?.text!=='Name\nPreview\nHello Fixture'||result.finalObservation?.title!=='Kiln owned fixture'||result.checks.length!==1||result.checks[0]?.passed!==true||proof?.value!=='Fixture'||proof?.result!=='Hello Fixture'||result.status!=='verified'||decisions!==2||model.calls.length!==0||cancelled.status!=='cancelled'||!JSON.stringify(independent.details).includes('Hello Fixture'))throw new Error('Native browser smoke assertions failed');
} finally {
 try { if(opened) { await cell(`await browser.close({name:${JSON.stringify(name)}}); display('owned-tab-closed')`); writeSync(1,JSON.stringify({cleanup:'owned-tab-closed'})+'\n'); } } finally { await handle.dispose();await meter.close();server.stop(true);rmSync(root,{recursive:true,force:true}); }
}
