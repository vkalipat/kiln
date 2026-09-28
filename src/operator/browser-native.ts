import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { browserGuardScript, browserSnapshotScript, browserVerificationScript } from "./browser-observation";
import { runBrowserWorkflow, validateBrowserTask, type BrowserTaskInput, type BrowserWorkflowResult } from "./browser-workflow";

type NativeLease = {tab:string;ownerSessionId:string;targetId:string;token:string};
const leases = new Map<string, {tab:object;sessionId:string}>();
export async function validateNativeBrowserLease(lease: NativeLease | undefined, callerSessionId: string): Promise<boolean> {
  if (!lease || typeof lease.token !== "string" || lease.ownerSessionId !== callerSessionId) return false;
  const expected=leases.get(lease.token); if(!expected || expected.sessionId!==callerSessionId) return false;
  const {getTab}=await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
  const tab=getTab(lease.tab);
  return leases.get(lease.token)===expected && tab===expected.tab && tab?.ownerSessionId===callerSessionId && tab?.targetId===lease.targetId && tab?.state==="alive";
}

export function buildBrowserWorkflowScript(raw: BrowserTaskInput, decideToolName = "kiln_browser_decide", cacheKey = `__kiln_${crypto.randomUUID().replaceAll("-", "")}`, nativeLease?: {tab:string;ownerSessionId:string;targetId:string;token:string}): string {
  const input = validateBrowserTask(raw);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(decideToolName)) throw new Error("Invalid browser decision tool");
  const snapshot = browserSnapshotScript(cacheKey);
  return `(async () => { const validateBrowserTask=${validateBrowserTask.toString()};
const runBrowserWorkflow=${runBrowserWorkflow.toString()};
const guardScript=${browserGuardScript.toString()};
const verificationScript=${browserVerificationScript.toString()};
const snapshotScript=${JSON.stringify(snapshot)}; let actionSequence=0;
const nativeLease=${JSON.stringify(nativeLease) ?? "undefined"};
if(nativeLease){const guard=await tool.kiln_browser_guard({nativeLease});const receipt=guard?.details??JSON.parse(typeof guard==='string'?guard:guard.text);
if(receipt?.valid!==true)return {status:'unsupported',quality:'specified_checks_only',taskQualityValidated:false,task:${JSON.stringify(input.task)},decisions:0,actions:0,reason:'Native tab ownership changed before observation',checks:[]};}
return await runBrowserWorkflow(${JSON.stringify(input)}, {
 now:()=>Date.now(),
 observe:async()=>{const s=await tab.evaluate(snapshotScript);if(!s)throw new Error('No snapshot');return s;},
 decide:async payload=>{payload.nativeLease=${JSON.stringify(nativeLease) ?? "undefined"};const r=await tool[${JSON.stringify(decideToolName)}](payload);const d=r?.details;if(d && typeof d.accepted==='boolean')return d;return JSON.parse(typeof r==='string'?r:r.text);},
 verify:async checks=>await tab.evaluate(verificationScript(snapshotScript,checks)),
 wait:async ms=>await wait(ms),
 act:async(a,s,value)=>{const token=${JSON.stringify(cacheKey)}+'_'+(++actionSequence)+'_'+a.id;
 const ready=await tab.evaluate(guardScript(${JSON.stringify(cacheKey)},snapshotScript,a,s,token));
 if(ready!=='ready')return {status:ready==='unsupported'?'unsupported':'stale',inputDispatched:false};
 const selector='[data-kiln-browser-ref="'+token+'"]';
 if(a.kind==='click')await tab.click(selector);
 else if(a.kind==='fill')await tab.fill(selector,value);
 else if(a.kind==='select')await tab.select(selector,a.value);
 else if(a.kind==='scroll')await tab.scroll(0,a.delta);
 else return {status:'unsupported'};
 return {status:'acted'};
 }
}); })()`;
}
export interface NativeBrowserWorkflowOptions { ctx: ExtensionContext; input: BrowserTaskInput; signal?: AbortSignal; toolCallId: string; decideToolName?: string }
export async function runNativeBrowserWorkflow(options: NativeBrowserWorkflowOptions): Promise<BrowserWorkflowResult> {
  const input = validateBrowserTask(options.input);
  const stop = (status: BrowserWorkflowResult["status"], reason: string): BrowserWorkflowResult => ({status,reason,quality:"specified_checks_only",taskQualityValidated:false,task:input.task,decisions:0,actions:0,checks:[]});
  if (/^(js|py|python)-/.test(options.toolCallId)) return stop("unsupported", "Call browser_task directly; nested eval execution cannot acquire its own kernel");
  if (options.signal?.aborted) return stop("cancelled", "Browser task cancelled before execution");
  const [{AgentRegistry},{getTab}] = await Promise.all([import("@oh-my-pi/pi-coding-agent"),import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor")]);
  const id=options.ctx.sessionManager.getSessionId();
  const session=AgentRegistry.global().list().find(ref=>ref.session?.sessionManager.getSessionId()===id)?.session;
  const tab=getTab(input.tab);
  if(!session || !tab || tab.ownerSessionId!==id || tab.state!=="alive" || tab.pending.size) return stop("unsupported","An idle live named tab owned by the calling session is required");
  const executor=session.getToolForEvalBridge("eval");
  if(!executor) return stop("unsupported","Native eval tool is not enabled or admitted");
  const nonce=crypto.randomUUID(), controller=new AbortController();
  const leaseToken=crypto.randomUUID(); leases.set(leaseToken,{tab,sessionId:id});
  const abort=()=>controller.abort(); options.signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(abort,input.timeoutMs!);
  try {
    if (options.signal?.aborted) return stop("cancelled", "Browser task cancelled before native dispatch");
    const code=`display({nonce:${JSON.stringify(nonce)},result:await browser.tab(${JSON.stringify(input.tab)}).run(${JSON.stringify(buildBrowserWorkflowScript(input,options.decideToolName,undefined,{tab:input.tab,ownerSessionId:id,targetId:tab.targetId,token:leaseToken}))},{timeout:${input.timeoutMs!/1000}})})`;
    const response=await executor.execute(options.toolCallId+"-browser",{language:"js",code,timeout:input.timeoutMs!/1000},controller.signal);
    const details=response.details as {jsonOutputs?:unknown[]}|undefined;
    const envelope=details?.jsonOutputs?.find((value):value is {nonce:string;result:BrowserWorkflowResult}=>typeof value==='object' && value!==null && (value as {nonce?:unknown}).nonce===nonce);
    if(envelope?.result && envelope.result.quality==="specified_checks_only" && envelope.result.taskQualityValidated===false && envelope.result.task===input.task) return envelope.result;
    return stop("ambiguous","Native execution produced no trustworthy receipt; inspect the tab before retrying");
  } catch { return stop("ambiguous","Native execution interrupted or failed; input may have executed, inspect before retrying"); }
  finally {leases.delete(leaseToken);clearTimeout(timer);options.signal?.removeEventListener("abort",abort);}
}
