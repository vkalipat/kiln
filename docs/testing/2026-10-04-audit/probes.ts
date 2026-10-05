import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, main } from '../../../src/cli/main.ts';
import { OperatorBudget } from '../../../src/operator/budget.ts';
import { TranscriptView } from '../../../src/tui/transcript.ts';
import { createOperatorMeter } from '../../../src/operator/meter.ts';
import { createComputeMonitor } from '../../../src/operator/compute-monitor.ts';
const root = mkdtempSync(join(tmpdir(), 'kiln-audit-probes-'));
const report:any = { fixtureRoot: root, providerCalls: 0, results: {} };
function emit(name:string,result:any) { report.results[name]=result; console.log(JSON.stringify({name,...result})); }
try {
 emit('parseArgs', {cases:[['task','--uncapped','Implement a formatter'], ['task','--json','Implement a formatter'], ['task','Implement a formatter','--budegt','1']].map(argv=>({argv,parsed:parseArgs(argv)}))});
 const captured:any[]=[]; let output='';
 const code=await main(['task','Implement a formatter','--budegt','1','--home',root,'--json'],{write:s=>output+=s,error:s=>output+=s},{createOperatorRuntime:async o=>{captured.push({seed:o.seed,budgetUsd:o.budgetUsd??'unset',wallSeconds:o.wallSeconds??'unset'});const run={id:'offline',dir:root};return {run,prompt:async()=>({run,text:'mock',stopped:'completed',costUsd:0,taskQualityValidated:false}),dispose:async()=>{}} as any;}});
 emit('unknownBudgetFlag',{code,captured});
 const budget=new OperatorBudget(10); const active=await budget.acquire(4);
 let small='pending'; const tooLarge=budget.acquire(11).then(()=>({state:'admitted'}),e=>({state:'rejected',error:e.message}));
 const affordable=budget.acquire(1).then(t=>{small='admitted';t.settle(0);return {state:'admitted'}},e=>{small='rejected';return {state:'rejected',error:e.message}});
 await Promise.resolve(); const before={charged:budget.chargedUsd,unused:10-budget.chargedUsd,small,queued:budget.queuedCount};active.settle(0);
 emit('budgetFIFO',{before,oversized:await tooLarge,affordable:await affordable,chargedAfter:budget.chargedUsd});
 const frame={frame:0,animations:true,subscribe:()=>()=>{}};const performanceRows=[];
 for (const n of [100,500,2000,5000]) {
  const entries:any[]=Array.from({length:n},(_,i)=>({id:`e${i}`,kind:'user',text:`Entry ${i}: a short synthetic result. This history is already complete.`}));
  entries.push({id:'active',kind:'tool',status:'running',verb:'bash',args:'synthetic'});
  const view=new TranscriptView(entries,{height:20,ticker:frame});
  const t=performance.now();view.render(100);const initial=performance.now()-t;
  const ticks=[];for(let i=0;i<3;i++){frame.frame++;const now=performance.now();view.render(100);ticks.push(performance.now()-now)}
  performanceRows.push({entries:n,initialMs:initial,tickMs:ticks,visibleRows:view.scrollState().visibleRows});
 }
 emit('transcriptPerf',{rows:performanceRows});
 const meterRows=[];
 for (const n of [100,500,1500]) {
  const dir=mkdtempSync(join(root,'meter-'));let snapshots=0;
  const compute=createComputeMonitor({runId:'synthetic',dir});let last:any;
  const meter=createOperatorMeter({run:{id:'synthetic',dir},limitUsd:null,onViolation:e=>{throw e},onUsage:s=>{snapshots++;last=s;compute.observeUsage(s)}});
  const t=performance.now();
  for(let i=0;i<n;i++){const ticket=await meter.reserveExternal({provider:'synthetic',model:'local',reservedUsd:0.01,sessionId:'synthetic'});if(!ticket)throw new Error('no ticket');ticket.dispatch();ticket.settle({costUsd:0.001,inputTokens:10,outputTokens:1});}
  const wall=performance.now()-t;meterRows.push({requests:n,wallMs:wall,msPerRequest:wall/n,snapshots,ledgerBytes:statSync(join(dir,'operator-meter.json')).size,rows:last.rows.length});await meter.close();
 }
 emit('meterPerf',{rows:meterRows});
} finally {
 writeFileSync('/tmp/kiln-audit-probes-20261004.json',JSON.stringify(report,null,2)+'\n');rmSync(root,{recursive:true,force:true});
}
