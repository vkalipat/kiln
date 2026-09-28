/** Explicit, tiny live qualification; synthetic data only. No key is written or printed. */
import { evaluateWithJev, JEV_MODEL, type JevChoiceQuestion, type JevState, type JevBatchDecision } from '../../src/integrations/jev';
import { createJevWorkflowService } from '../../src/operator/jev-service';

const q = (instructions: string, criteria: Record<string,string>): JevChoiceQuestion => ({ instructions, criteria });
const research = {
  relevant: q('Does evidence discuss the claim subject?', { yes:'Discusses sample results', no:'Different subject' }),
  contradiction: q('Does evidence explicitly falsify the claim? Unmeasured results do not falsify it.', { yes:'Explicit failing sample', no:'No explicit failing sample' }),
  complete: q('Does evidence settle whether every sample passed? An explicit failure settles the universal claim as false. An unmeasured sample leaves it unresolved.', { yes:'Universal claim settled true or false', no:'Insufficient measurements' }),
};
export const qualificationFixtures: {id:string;state:JevState;questions:Record<string,JevChoiceQuestion>;expected:Record<string,string>}[] = [
  {id:'browser-before-input',state:{goal:'Preview the form, do not submit it',controls:[{id:'preview',label:'Preview',enabled:true},{id:'submit',label:'Submit',enabled:true}],previewVisible:false},questions:{
    target:q('Which existing control advances the goal without submitting?',{preview:'Preview control',submit:'Submit control',none:'Neither'}),
    operation:q('What is the next action on the chosen existing control?',{click:'Click the preview control',done:'Goal already achieved',stop:'Cannot proceed'}),
    complete:q('Is preview already visible?',{yes:'Visible',no:'Not visible'}),
  },expected:{target:'preview',operation:'click',complete:'no'}},
  {id:'research-contradiction',state:{claim:'Every sample passed',evidence:'Sample A passed. Sample B failed the specified check.'},questions:research,expected:{relevant:'yes',contradiction:'yes',complete:'yes'}},
  {id:'research-missing-evidence',state:{claim:'Every sample passed',evidence:'Sample A passed. Sample B was not measured.'},questions:research,expected:{relevant:'yes',contradiction:'no',complete:'no'}},
];
export async function runLiveQualification(options:{apiKey:string;fetch?:typeof fetch}) {
  if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
  let dispatches=0;
  const transport=(async (url: Parameters<typeof fetch>[0], init?:RequestInit) => {
    if (++dispatches>9) throw new Error('Qualification dispatch limit');
    return (options.fetch??fetch)(url,init);
  }) as typeof fetch;
  type Decision=Omit<JevBatchDecision,'reason'>&{reason:string};
  const rows: {fixture:string;arm:string;latencyMs:number;success:boolean;labels:Record<string,{choice:string;accepted:boolean}>;decisions:Decision[]}[]=[];
  const observe=(fixture:typeof qualificationFixtures[number],arm:string,decisions:Decision[],latencyMs:number)=>{
    const labels=Object.assign({},...decisions.map(d=>Object.fromEntries(Object.entries(d.answers??{}).map(([id,a])=>[id,{choice:a.choice,accepted:a.accepted}]))));
    const success=Object.entries(fixture.expected).every(([id,value])=>labels[id]?.choice===value&&labels[id]?.accepted===true);
    rows.push({fixture:fixture.id,arm,latencyMs,success,labels,decisions});
  };
  const settings={enabled:true,apiKey:options.apiKey,fetch:transport,timeoutMs:30000,minConfidence:0.8};
  // Alternate ordering avoids always assigning the first cold request to the same arm.
  for(const [index,fixture] of qualificationFixtures.slice(0,2).entries()) for(const arm of index?['batch','sequential']:['sequential','batch']) {
    const start=performance.now(); const decisions:JevBatchDecision[]=[];
    const groups=arm==='batch'?[fixture.questions]:Object.entries(fixture.questions).map(([id,question])=>({[id]:question}));
    for(const questions of groups) decisions.push(await evaluateWithJev(fixture.state,questions,settings));
    observe(fixture,arm,decisions,performance.now()-start);
  }
  const signal=new AbortController().signal;
  const service=createJevWorkflowService({...settings,maxCalls:1,maxInputTokens:64000,signal:()=>signal,onStats:()=>{},reserve:async()=>({dispatch:()=>true,settle:()=>{}})});
  const fixture=qualificationFixtures[2]!;
  const request={operation:'research' as const,sessionId:'synthetic-live-qualification',state:fixture.state,questions:fixture.questions};
  const before=dispatches; const start=performance.now();
  const [first,concurrent]=await Promise.all([service.evaluate(request),service.evaluate(request)]);
  const cached=await service.evaluate(request);
  observe(fixture,'exact-state-reuse',[first],performance.now()-start);
  const decisions=rows.flatMap(row=>row.decisions);
  const known=decisions.filter(d=>d.usage);
  const unknownRequests=decisions.filter(d=>!d.usage&&d.reason!=='invalid_input').length;
  const inputTokens=known.reduce((n,d)=>n+d.usage!.input_tokens,0),outputTokens=known.reduce((n,d)=>n+d.usage!.output_tokens,0);
  return {schema:'kiln-jev-live-qualification-v1',model:JEV_MODEL,checkedAt:new Date().toISOString(),dispatches,
    limits:{maxRequests:9,estimatedMaximumReservedUsd:9*64000*0.042/1e6,reservationTokensPerRequest:64000,timeoutMsPerRequest:30000},
    usage:{inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,unknownRequests,complete:unknownRequests===0},
    cost:{knownUsd:inputTokens*0.042/1e6,unknownExposureUsd:unknownRequests*64000*0.042/1e6,priceUsdPerMillionInput:0.042,outputPrice:0},
    taskSuccess:rows.every(row=>row.success),rows,
    reuse:{requests:dispatches-before,concurrent:concurrent.reuse?.kind,cached:cached.reuse?.kind,success:dispatches-before===1&&concurrent.reuse?.kind==='inflight'&&cached.reuse?.kind==='cache'},
    caveats:['Three synthetic labeled fixtures; not a representative accuracy benchmark.','64k-token reservation follows current service accounting; it is not an enforced provider billing guarantee.','Browser labels do not execute or verify browser actions.','Research labels do not verify source truth.','Sequential-versus-batched latency has one observation per fixture, not a universal speedup.','Reuse is application cache/singleflight, not provider prompt caching.','No frontier baseline or paid frontier task completion is measured.']};
}
if(import.meta.main){
  if(process.argv.slice(2).join(' ')!=='--live')throw new Error('Explicit --live required; maximum 9 provider requests, reserved exposure $0.024192');
  const report=await runLiveQualification({apiKey:process.env.TYPESAFE_API_KEY??''});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.taskSuccess||!report.reuse.success)process.exitCode=1;
}
