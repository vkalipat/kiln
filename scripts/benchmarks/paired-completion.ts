/** Exploratory task completion comparison. Preparation and oracle tests never dispatch models. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync, cpSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, type StreamFn } from '@oh-my-pi/pi-agent-core';
import { streamSimple, type FetchImpl } from '@oh-my-pi/pi-ai';
import { getBundledModel } from '@oh-my-pi/pi-catalog';
import { coworkFetch } from '@oh-my-pi/pi-ai/providers/cowork-fetch';
import { main } from '../../src/cli/main';
import { createCliRuntime } from '../../src/cli/runtime';
import { finishProcess } from '../../src/cli/exit';
import { loadConfig, saveConfig } from '../../src/core/config';
import { initHome } from '../../src/core/home';
import { kilnHome, writeAtomic } from '../../src/core/paths';
import { RunRecord } from '../../src/core/record';
import { runPaths, readStatus } from '../../src/core/run';
import { RunControl, withRunControl } from '../../src/core/run-control';
import { modelCostUsd } from '../../src/providers/models';
import { readTool } from '../../src/brain/tools/read';
import { writeTool } from '../../src/brain/tools/write';
import { editTool } from '../../src/brain/tools/edit';
import { bashTool } from '../../src/brain/tools/bash';
import { requestBody } from './runtime-pilot';
import { reservation, settleReservation } from './delivery-recovery-pilot';
import { assertDirectWorkflow, outputAllowance, serializableConfig, sourceHash } from './delivery-validation';
import { loadFrozenRouting, type FrozenRouting } from '../../src/workflow/routing';
import { planWorkflow, compileWorkflow } from '../../src/workflow/plan';
import { projectPaths } from '../../src/formation/paths';
import { checkNeeds } from '../../src/ideation/probe';
import { elapsedByPhase } from '../../src/core/budget';
import { routeResume } from '../../src/cli/commands/run-routing';
import { acquireRunLock } from '../../src/core/lock';

export const CAPS = { total: 9, simple: 3, full: 9 } as const;
export const CAMPAIGN = {hardCapUsd:100,priorRecordedUsd:57.28073825,retainedUncertaintyUsd:20.9799365,separateIdeationReservationUsd:10,csvReservationUsd:9,maximumAccountedUsd:97.26067475};
const RECOVERY_HOME='/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-task-worker-TfQczN';
const RECOVERY_ROOT='/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-Ddge2B';
const PRIOR_ROOTS=['/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-8hJh6T','/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-IXzYkb','/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-AWx44c'];
export function lineageHomes(roots: string[]) {
  return [...new Set(roots.flatMap(root=>Object.values(JSON.parse(readFileSync(join(root,'ledger.json'),'utf8')).arms).map((state:any)=>state.home as string)))];
}
export function phaseCompletion(status: any, events: any[]) {
  const ends=events.filter(event=>event.t==='phase.end');
  const latest=Object.fromEntries(ends.map(event=>[event.phase,event.outcome]));
  return {deliverySucceeded:status?.state==='done'&&status?.outcome?.kind==='success',phaseEnds:ends,latestPhaseOutcomes:latest,reflectionSucceeded:latest.reflect==='ok',allRequestedStagesSucceeded:['frame','form','build','reflect'].every(phase=>latest[phase]==='ok')};
}
export function dependencyPreflight() {
  const missing=checkNeeds(['python3']);if(missing.length)throw new Error(`Missing evaluator prerequisite: ${missing.join(', ')}`);
}
export function recoveryLimits(priorChargedUsd:number,priorElapsedMs:number) {
  if(!Number.isFinite(priorChargedUsd)||priorChargedUsd<0||!Number.isFinite(priorElapsedMs)||priorElapsedMs<0)throw new Error('Invalid prior recovery accounting');
  const usd=10-priorChargedUsd,wallMs=1500000-priorElapsedMs; // Historical logical recovery cap, not the new CSV cap.
  if(usd<=0||wallMs<=0)throw new Error('Original logical arm budget exhausted');
  return {usd,wallMs};
}
export function immutableRecoveryFiles(home:string) {
  const active=runPaths(home,'paired'),project=projectPaths(active.project);
  const paths=[join(home,'config.json'),active.seed,join(active.dir,'workflow.json'),join(active.dir,'routing.json'),active.features,active.acceptanceLock,project.spec,project.initSh,project.projectJson,project.featuresMirror,project.lockMirror];
  return Object.fromEntries(paths.map(path=>[relative(home,path),hash(readFileSync(path))]));
}
export function withRecoveryLock<T>(home:string,action:()=>T):T {
  const lock=acquireRunLock(runPaths(home,'paired'));try{return action();}finally{lock.release();}
}
function recoverySnapshotUnlocked() {
  const active=runPaths(RECOVERY_HOME,'paired'),status=readStatus(active),record=new RunRecord(active.record),events=record.read();
  if(status.state!=='failed'||status.phase!=='build'||!status.outcome?.message?.includes('acceptance contract exceeds'))throw new Error('Expected preserved pre-builder contract-size failure');
  if(readFileSync(active.seed,'utf8').trim()!==TASKS[0].prompt)throw new Error('Recovery task seed differs');
  assertDirectWorkflow(active);assertPairedRouting(loadFrozenRouting(active));
  const previous=JSON.parse(readFileSync(join(RECOVERY_ROOT,'ledger.json'),'utf8')).arms['slugify/full'];
  if(Math.abs(previous.chargedUsd-3.93711425)>1e-8||Math.abs(record.costUsd()-previous.spentUsd)>1e-8)throw new Error('Recovery prior accounting changed');
  const journalElapsedMs=Object.values(elapsedByPhase(events,Date.now())).reduce((sum,value)=>sum+(value??0),0)*1000;
  const priorElapsedMs=Math.max(previous.elapsedMs,journalElapsedMs);
  return {label:'Recovery validation of the preserved logical full arm; not single-attempt or a fresh paired trial',home:RECOVERY_HOME,runId:'paired',nativeResumeRoute:routeResume(status,existsSync(active.frontier),loadConfig(RECOVERY_HOME)),priorController:RECOVERY_ROOT,priorSpentUsd:previous.spentUsd,priorChargedUsd:previous.chargedUsd,priorElapsedMs,journalElapsedMs,limits:recoveryLimits(previous.chargedUsd,priorElapsedMs),immutableFiles:immutableRecoveryFiles(RECOVERY_HOME),initialStatusHash:hash(readFileSync(active.status)),initialRecordHash:hash(readFileSync(active.record)),initialEventCount:events.length};
}
export function recoverySnapshot() { return withRecoveryLock(RECOVERY_HOME,recoverySnapshotUnlocked); }
export function assertRecoveryHistory(recovery:any) {
  const active=runPaths(recovery.home,'paired');
  if(hash(readFileSync(active.status))!==recovery.initialStatusHash||hash(readFileSync(active.record))!==recovery.initialRecordHash)throw new Error('Recovery history changed since preparation');
}
export function qualifiedTaskSuccess(state:any) {
  return Boolean(state.completed&&state.artifactCorrect&&!state.contaminationObserved&&(!state.recovery||state.immutableArtifactsPreserved===true));
}
export function assertRecoverySnapshot(recovery:any,initial=false) {
  const active=runPaths(recovery.home,'paired');
  if(JSON.stringify(immutableRecoveryFiles(recovery.home))!==JSON.stringify(recovery.immutableFiles))throw new Error('Frozen recovery artifacts changed');
  if(readFileSync(active.seed,'utf8').trim()!==TASKS[0].prompt)throw new Error('Recovery seed differs');
  assertDirectWorkflow(active);assertPairedRouting(loadFrozenRouting(active));
  if(initial)assertRecoveryHistory(recovery);
}
export function selectedArms(taskId: string, arm?: string): ('simple'|'full')[] {
  if(taskId==='csv-total'&&arm===undefined)return ['simple','full'];
  throw new Error('This protocol admits only csv-total with both fresh arms, simple first');
}
export function workerProject(home: string, arm: 'simple'|'full') {
  if(arm==='full')return runPaths(home,'paired').project; // Native CLI exclusively creates the run and project.
  const project=join(home,'project');mkdirSync(project,{recursive:true});return project;
}
export function artifactDirectory(project: string, arm: 'simple'|'full') { return arm==='full'?projectPaths(project).repo:project; }
export function assertPairedRouting(routing: FrozenRouting | undefined) {
  if (!routing) throw new Error('Missing frozen routing');
  for (const role of ['brain','builder'] as const) {
    if(routing.roles[role][0]!=='anthropic/claude-fable-5-1') throw new Error(`Paired ${role} must use Fable`);
    if((routing.effectiveEffort?.[role]??routing.effortByRole?.[role]??routing.effort)!=='xhigh') throw new Error(`Paired ${role} must use xhigh`);
  }
  for(const role of ['critic','auditor'] as const) {
    if(routing.roles[role][0]!=='anthropic/claude-opus-5') throw new Error(`Paired ${role} must use Opus`);
    if((routing.effectiveEffort?.[role]??routing.effortByRole?.[role]??routing.effort)!=='xhigh') throw new Error(`Paired ${role} must use xhigh`);
  }
  return routing;
}
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
function helperHashes() {
  return Object.fromEntries(['runtime-pilot.ts','delivery-recovery-pilot.ts','delivery-validation.ts'].map(file=>[file,hash(readFileSync(join(import.meta.dir,file)))]));
}
const COMMON = 'Use only the Python standard library. Put the named CLI at the project root. Include unittest tests discoverable and passing with python3 -m unittest discover -v from the project root, and a concise README.md with usage. This is a small local implementation task; no external research, installation, hosted service or deployment is needed. Finish when the CLI and tests pass.';
export const TASKS = [
  { id: 'slugify', file: 'slugify.py', prompt: `Create and ship slugify.py. Invoke it as python3 slugify.py TEXT, with exactly one positional UTF-8 string. Apply Unicode NFKD normalization, discard non-ASCII characters, lowercase, replace each run of characters outside a-z and 0-9 with one hyphen, and trim boundary hyphens. Print exactly the resulting slug plus a newline to stdout. Reject an empty resulting slug or wrong argument count with nonzero status. ${COMMON}` },
  { id: 'csv-total', file: 'group_total.py', prompt: `Create and ship group_total.py. Invoke it as python3 group_total.py INPUT.csv with exactly one positional filename. Read UTF-8 CSV using standard CSV quoting rules, with exact header category,amount and exactly two fields in every data record. Reject blank/whitespace-only categories; otherwise preserve category text exactly. Amounts must be finite decimal numbers (optional sign, digits with optional decimal point); trim surrounding amount whitespace, reject nonnumeric, NaN, infinity, or exponent notation. Sum with exact decimal arithmetic per category, sort categories in Python string order, and write CSV to stdout with header category,total. Format totals in plain decimal notation with no unnecessary trailing fractional zeros, no trailing decimal point, and zero as 0. Header-only input succeeds with header-only output. On malformed CSV (including unterminated quotes), wrong header/row width, missing file, invalid amount/category, or wrong argument count, fail with nonzero status and no partial stdout. ${COMMON}` },
] as const;
export function preflightTaskRoutes() {
  return TASKS.map(task=>{
    const plan=planWorkflow(task.prompt,{adaptive:true});
    const execution=compileWorkflow(plan,{through:'reflect',autonomous:true});
    if(plan.intent==='existing_artifact'||plan.strategy?.mode!=='direct'||execution.phases.some(phase=>['discover','ideate','checkpoint'].includes(phase)))throw new Error(`Offline task-route preflight failed for ${task.id}`);
    return {id:task.id,plan,execution};
  });
}
type Check = { name: string; args?: string[]; input?: string; stdout?: string; rows?: string[][]; fails?: boolean };
export const ORACLES: Record<string, Check[]> = {
  slugify: [
    { name: 'accents', args: ['Crème Brûlée déjà vu'], stdout: 'creme-brulee-deja-vu\n' },
    { name: 'punctuation', args: ['  Hello___WORLD!! 42  '], stdout: 'hello-world-42\n' },
    { name: 'non-ascii', args: ['abc東京def'], stdout: 'abcdef\n' },
    { name: 'empty', args: [''], fails: true }, { name: 'no-ascii', args: ['東京!!!'], fails: true },
    { name: 'missing-arg', args: [], fails: true }, { name: 'extra-arg', args: ['one', 'two'], fails: true },
  ],
  'csv-total': [
    { name: 'exact-sorted', input: 'category,amount\nz,0.1\na,1.20\nz,0.2\na,-0.20\n', rows: [['category','total'],['a','1'],['z','0.3']] },
    { name: 'quotes-and-zero', input: 'category,amount\n"a,b",-1.250\n"a,b",1.25\n"x""y", 2.500 \n', rows: [['category','total'],['a,b','0'],['x"y','2.5']] },
    { name: 'large-precision', input: 'category,amount\na,123456789012345678901234567890.1\na,0.2\n', rows: [['category','total'],['a','123456789012345678901234567890.3']] },
    { name: 'header-only', input: 'category,amount\n', rows: [['category','total']] },
    ...['category,amount\na,2\nb,nope\n','amount,category\n1,a\n','category,amount\na,1,extra\n','category,amount\na\n','category,amount\n"a,1\n','category,amount\n ,1\n',...['NaN','Infinity','1e2'].map(v=>`category,amount\na,${v}\n`)].map((input,i)=>({name:`invalid-${i}`,input,fails:true})),
    { name: 'missing-file', args: ['does-not-exist.csv'], fails: true }, { name: 'missing-arg', args: [], fails: true }, { name: 'extra-arg', args: ['one.csv','two.csv'], fails: true },
  ],
};
export function safeProject(root: string, project: string): string {
  const actual = realpathSync(project), rel = relative(realpathSync(root), actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Project must be a real descendant of isolated arm root');
  return actual;
}
export function normalExit(code: number, signal: string | null | undefined) { return !signal && Number.isInteger(code) && code >= 0 && code <= 255; }
export function validateLedger(ledger: any) {
  const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!ledger || !finite(ledger.chargedUsd)||!finite(ledger.spentUsd)||!Array.isArray(ledger.calls)||!ledger.arms||typeof ledger.arms!=='object'||Array.isArray(ledger.arms)) throw new Error('Invalid ledger');
  for(const state of Object.values(ledger.arms) as any[]) if(!finite(state.chargedUsd)||!finite(state.spentUsd))throw new Error('Invalid arm ledger');
  for(const call of ledger.calls) for(const key of ['reserveUsd','chargedUsd','costUsd']) if(call[key]!==undefined&&!finite(call[key]))throw new Error('Invalid call ledger');
  if(Math.abs(Object.values(ledger.arms).reduce((sum:number,state:any)=>sum+state.chargedUsd,0)-ledger.chargedUsd)>1e-7)throw new Error('Ledger arm total mismatch');
  return ledger;
}
export function lockedLedger(root: string) {
  const lock=join(root,'execution.lock'),fd=openSync(lock,'wx',0o600);
  const release=()=>{closeSync(fd);unlinkSync(lock);};
  try {
    const path=join(root,'ledger.json');
    const ledger=validateLedger(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{chargedUsd:0,spentUsd:0,calls:[],arms:{}});
    return {ledger,release};
  } catch(error){release();throw error;}
}
export function auditToolAccess(name: string, args: unknown, home: string, controller: string, priorHomes: string[] = []) {
  const text=JSON.stringify(args),flags:string[]=[];
  if(/paired-completion|oracles|grading|prepared-runner|ledger\.json|kiln-paired-completion|kiln-paired-controller/.test(text)||text.includes(controller))flags.push('evaluator-or-oracle-reference');
  if(priorHomes.some(path=>text.includes(path)||text.includes(existsSync(path)?realpathSync(path):resolve(path))))flags.push('prior-arm-access');
  if(text.includes('../'))flags.push('relative-parent-access');
  if(args&&typeof args==='object'&&'path' in args&&typeof args.path==='string') {
    const path=resolve(home,'project',args.path),rel=relative(home,path);
    if(rel.startsWith('..')||isAbsolute(rel))flags.push('outside-arm-path');
  }
  if(name==='bash' && /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)/.test(text)) {
    const stripped=text.replaceAll(home,'').replaceAll(realpathSync(home),'');
    if(/(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)/.test(stripped))flags.push('outside-arm-shell-path');
  }
  return {name,args,flags};
}
export async function gradeProject(taskId: string, project: string, oracleRoot: string, timeoutMs=10000) {
  const task = TASKS.find(t=>t.id===taskId)!;
  const results: any[] = [];
  for (const check of ORACLES[taskId]!) {
    const input = join(oracleRoot, `${taskId}-${check.name}.csv`);
    if (check.input !== undefined) writeAtomic(input,check.input,{mode:0o600});
    const proc = Bun.spawn(['python3',join(project,task.file),...(check.input === undefined ? check.args! : [input])],{cwd:project,stdout:'pipe',stderr:'pipe',timeout:timeoutMs});
    const [code,stdout,stderr] = await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
    let pass = normalExit(code,proc.signalCode) && (check.fails ? code !== 0 && (taskId !== 'csv-total' || stdout === '') : code === 0);
    if (check.stdout !== undefined) pass &&= stdout === check.stdout;
    if (check.rows) {
      const parsed = Bun.spawn(['python3','-c','import csv,json,sys; print(json.dumps(list(csv.reader(sys.stdin, strict=True))))'],{stdin:new Blob([stdout]),stdout:'pipe',stderr:'pipe',timeout:10000});
      const [parseCode,text] = await Promise.all([parsed.exited,new Response(parsed.stdout).text()]);
      try { pass &&= parseCode === 0 && JSON.stringify(JSON.parse(text || 'null')) === JSON.stringify(check.rows); }
      catch { pass = false; }
    }
    results.push({name:check.name,pass,code,signal:proc.signalCode,stdout,stderr});
  }
  const docs = existsSync(join(project,'README.md')) && readFileSync(join(project,'README.md'),'utf8').trim().length > 0;
  // Model-authored tests are explicitly separate from the external behavioral oracle.
  const tests = Bun.spawn(['python3','-m','unittest','discover','-v'],{cwd:project,stdout:'pipe',stderr:'pipe',timeout:30000});
  const [testCode,testOut,testErr] = await Promise.all([tests.exited,new Response(tests.stdout).text(),new Response(tests.stderr).text()]);
  const count = Number(`${testOut}\n${testErr}`.match(/Ran (\d+) tests?/)?.[1] ?? 0);
  return {allOraclePass:results.every(r=>r.pass),results,readmePresent:docs,modelTests:{code:testCode,count,pass:testCode===0&&count>0,stdout:testOut,stderr:testErr}};
}
export function prepare(resumeExisting=false) {
  if(resumeExisting)throw new Error('CSV-only protocol does not admit slugify or recovery');
  const taskRoutes=preflightTaskRoutes();
  dependencyPreflight();
  const root=mkdtempSync(join(tmpdir(),'kiln-paired-completion-')); chmodSync(root,0o700);
  const protocol={version:1,createdAt:new Date().toISOString(),tasks:TASKS,oracleHash:hash(JSON.stringify(ORACLES)),caps:CAPS,sourceHash:sourceHash(resolve(import.meta.dir,'../..')),scriptHash:hash(readFileSync(import.meta.filename)),baseModel:'anthropic/claude-fable-5-1',reviewModel:'anthropic/claude-opus-5',effort:'xhigh',maxTokens:{general:16384,strict:32768},wallSeconds:1500,order:['slugify/simple','slugify/full','csv-total/full','csv-total/simple'],scoring:'Single attempt; all independent oracles, README and positive-count passing model tests; completion separately requires normal successful harness termination. No retries or correctness feedback. Exploratory two-task smoke comparison, not a general capability estimate.'};
  Object.assign(protocol,{taskRoutes,helperHashes:helperHashes(),order:['slugify/full','csv-total/full','csv-total/simple'],artifactMapping:{simple:'<opaque-home>/project',full:'<opaque-home>/runs/paired/project/repo',nativeFullOutput:'No --out argument; no precreated run or project; native exclusive reservation and default formation directory'},lineage:{previousRoots:PRIOR_ROOTS,priorHomes:lineageHomes(PRIOR_ROOTS),previousRecordedUsd:3.42538775,previousChargedUsd:3.42538775,previousFullDispositions:['Zero-dispatch direct-workflow preflight failure: greenfield project-root requirement classified as existing artifact.','Frame completed, then benchmark --out inside protected home rejected before formation. Recorded $0.264115; preserved as runner setup failure.','Frame and form passed, build blocked on generated dependency prose, reflection passed. Recorded $2.33636025; no implementation.'],reusedSimpleBaseline:{root:'/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-IXzYkb',arm:'slugify/simple',sourceHash:'ca02a64f15ad2c811198c478715adb07b4de2c15a29b65c30d1bdc5236f2544b',recordedUsd:0.368466,disposition:'Successful earlier-core baseline reused as a diagnostic control. DIFFERENT production core after fixes: not a same-source or newly independent paired trial. Baseline artifacts/results are never supplied to workers. CSV arms, if authorized, share the fresh frozen source.'},originalCampaignAllocationUsd:28,freshAllocationUsd:CAPS.total},isolation:'Solver homes are separate opaque temporary directories, not descendants of the controller. Tools are not OS-sandboxed: prewritten external oracles are independent but not a security-isolated or official hidden benchmark. Tool arguments are audited; observed evaluator/prior-arm access disqualifies the affected result. Independent parent source audit for fixture hardcoding remains required.'});
  const controller=protocol as any;
  controller.lineage.previousRoots=[...PRIOR_ROOTS,RECOVERY_ROOT];controller.lineage.priorHomes=lineageHomes(controller.lineage.previousRoots);
  controller.lineage.previousRecordedUsd=7.362502;controller.lineage.previousChargedUsd=7.362502;
  controller.lineage.previousFullDispositions.push('Ddge2B: formation and init passed, builder rejected oversized inline contract before implementation, reflection passed; $3.93711425 and 798.121s retained against logical full-arm limits.');
  if(resumeExisting) {
    controller.recovery=withRecoveryLock(RECOVERY_HOME,()=>{
      const snapshot=recoverySnapshotUnlocked();
      cpSync(runPaths(RECOVERY_HOME,'paired').dir,join(root,'before-resume','run'),{recursive:true});
      cpSync(join(RECOVERY_HOME,'config.json'),join(root,'before-resume','config.json'));
      return snapshot;
    });
    if(controller.recovery.nativeResumeRoute.kind!=='phase'||controller.recovery.nativeResumeRoute.phase!=='build')throw new Error('Native run resume does not admit this preserved build failure; no paid recovery can be prepared');
    controller.scoring='Recovery validation, not single-attempt or a fresh paired trial. Existing acceptance artifacts, model routing, logical cost and active wall budget remain frozen. External artifact correctness, native delivery, reflection and all-stage outcomes reported separately. CSV remains a future fresh same-source comparison.';
  }
  const previousRecovery='/var/folders/h7/xh65m1594r3b9y7pb51g85gc0000gn/T/kiln-paired-completion-AiPGq6';
  controller.scope='csv-only';controller.tasks=[TASKS[1]];controller.order=['csv-total/simple','csv-total/full'];controller.campaign=CAMPAIGN;
  controller.lineage.previousRoots.push(previousRecovery);controller.lineage.priorHomes=lineageHomes(controller.lineage.previousRoots);
  controller.lineage.previousRecordedUsd=9.686443;controller.lineage.previousChargedUsd=9.686443;
  controller.lineage.reusedSimpleBaseline.role='Historical slugify lineage only; not a reused control for the fresh CSV comparison';
  controller.lineage.previousFullDispositions.push('AiPGq6 native recovery completed delivery and reflection with seven independent oracles and eleven model tests passing; incremental $2.323941. Prior failed observations remain preserved.');
  controller.lineage.originalCampaignAllocationUsd=28;
  controller.lineage.allocationClarification='The former internal $28 allocation is a planning target, not an unchanged hard cap: prior trials $9.686443 + new CSV $9 + separately reserved ideation $10 = $28.686443. The user-authorized $100 campaign hard cap remains respected, with maximum accounted amount $97.26067475 including retained uncertainty.';
  controller.scoring='Prospective fresh CSV task comparison on one frozen production core. Simple arm first to fund the baseline before full orchestration; not a counterbalanced statistical trial. Same task, oracle, models, effort, output ceilings and 1500-second per-arm wall limit; shared $9 conservative cap includes all in-flight and unknown usage. Report independent artifact correctness, native delivery, reflection and all-stage outcomes separately. No slugify or recovery dispatch under this protocol.';
  writeAtomic(join(root,'protocol.json'),JSON.stringify(protocol,null,2),{mode:0o600});
  writeAtomic(join(root,'prepared-runner.ts'),readFileSync(import.meta.filename,'utf8'),{mode:0o600});
  const repository=resolve(import.meta.dir,'../..');
  for(const path of ['src','bin','prompts','package.json','bun.lock'])if(existsSync(join(repository,path)))cpSync(join(repository,path),join(root,'source',path),{recursive:true});
  for(const file of Object.keys(helperHashes()))cpSync(join(import.meta.dir,file),join(root,`helper-${file}`));
  console.log(JSON.stringify({prepared:root,protocol})); return root;
}

async function run(root: string, taskId: string, armFilter?: string) {
  if(!Bun.argv.includes('--confirm-spend')) throw new Error('Paid execution requires parent green and --confirm-spend');
  preflightTaskRoutes();
  dependencyPreflight();
  const protocol=JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'));
  if(protocol.scope!=='csv-only'||taskId!=='csv-total'||armFilter!==undefined)throw new Error('Only the new CSV comparison is authorized by this protocol');
  if(protocol.sourceHash!==sourceHash(resolve(import.meta.dir,'../..')) || protocol.scriptHash!==hash(readFileSync(import.meta.filename)) || JSON.stringify(protocol.helperHashes)!==JSON.stringify(helperHashes()) || protocol.oracleHash!==hash(JSON.stringify(ORACLES))) throw new Error('Frozen source/script/helper/oracle mismatch');
  if(!TASKS.some(t=>t.id===taskId)) throw new Error('Unknown task');
  const task=TASKS.find(t=>t.id===taskId)!;
  const arms=selectedArms(taskId,armFilter);
  const recovery:any=undefined; // Historical recovery machinery is not admitted by the CSV-only scope.
  if(recovery)assertRecoverySnapshot(recovery,true);
  const ledgerPath=join(root,'ledger.json');
  const {ledger,release}=lockedLedger(root);
  const persist=()=>{ledger.cumulativeTrialSpentUsd=protocol.lineage.previousRecordedUsd+ledger.spentUsd;ledger.cumulativeTrialChargedUsd=protocol.lineage.previousChargedUsd+ledger.chargedUsd;writeAtomic(ledgerPath,JSON.stringify(ledger,null,2),{mode:0o600});};
  try {
    const authHome=resolve(kilnHome()), cfg=loadConfig(authHome);
    cfg.budgets.usd=25;cfg.budgets.wallSeconds=1500;cfg.routing={mode:'adaptive'};cfg.autonomous=true;cfg.provider.fallbacks='off';cfg.effort='xhigh';
    const runtime=await createCliRuntime(authHome,cfg,{runtimeEffort:{enabled:false}});
    for(const arm of arms) {
      const key=`${taskId}/${arm}`;
      if(ledger.arms[key]) throw new Error('Arm already started; no duplicate or budget reset');
      const home=recovery?recovery.home:mkdtempSync(join(tmpdir(),'kiln-task-worker-'));
      if(!recovery){chmodSync(home,0o700);initHome(home,{plugAndPlay:true});saveConfig(home,cfg);}
      const armCap=recovery?recovery.limits.usd:CAPS[arm],wallMs=recovery?recovery.limits.wallMs:1500000;
      const privateDir=join(root,taskId,arm);mkdirSync(privateDir,{recursive:true});
      const state:any={chargedUsd:0,spentUsd:0,startedAt:new Date().toISOString(),home,config:serializableConfig(recovery?loadConfig(home):cfg),incrementalUsdCap:armCap,incrementalWallMs:wallMs,...(recovery?{recovery}: {})};ledger.arms[key]=state;persist();
      const control=new RunControl(),pending=new Set<Promise<unknown>>();let preflight=arm==='simple';
      const capped:StreamFn=(model,context,options)=>{
        control.signal.throwIfAborted();if(!preflight)throw new Error('Adaptive direct preflight missing before dispatch');
        if(recovery)assertRecoverySnapshot(recovery);
        if(model.provider!=='anthropic'||!['claude-fable-5-1','claude-opus-5'].includes(model.id))throw new Error('Unapproved model');
        const maxTokens=outputAllowance(context.tools);let reserve=reservation(model.cost,Buffer.byteLength(JSON.stringify(context)),maxTokens),dispatched=false;
        const charge=(delta:number)=>{if(delta>0&&(ledger.chargedUsd+delta>CAPS.total||state.chargedUsd+delta>armCap)){control.cancel('Conservative reservation cap');throw new Error('Conservative reservation cap');}ledger.chargedUsd+=delta;state.chargedUsd+=delta;};
        charge(reserve);const entry:any={arm:key,model:`${model.provider}/${model.id}`,maxTokens,reserveUsd:reserve,dispatched:false,tools:context.tools?.map(t=>t.name),startedAt:new Date().toISOString()};ledger.calls.push(entry);persist();
        const guardedFetch:FetchImpl=async(url,init)=>{
          control.signal.throwIfAborted();if(dispatched)throw new Error('Transport retry disabled');
          const body=await requestBody(url,init),wire=JSON.parse(body);if(wire.model!==model.id||wire.max_tokens!==maxTokens)throw new Error('Wire model/output mismatch');
          const exact=reservation(model.cost,Buffer.byteLength(body),maxTokens);charge(exact-reserve);reserve=exact;dispatched=true;Object.assign(entry,{reserveUsd:reserve,dispatched:true});persist();return coworkFetch(url,init);
        };
        const {fallbacks:_,...rest}=options??{};
        const stream=streamSimple(model,context,{...rest,maxTokens,fetch:guardedFetch,signal:options?.signal?AbortSignal.any([options.signal,control.signal]):control.signal,acceptEmptyResponse:true,preferWebsockets:false});
        const done=stream.result().then(message=>{
          const actual=modelCostUsd(model,message.usage),keep=dispatched?settleReservation(reserve,actual,message.stopReason):0;
          // Settlement can exceed a reservation: retain actual spend and stop, never discard it.
          ledger.chargedUsd+=keep-reserve;state.chargedUsd+=keep-reserve;
          if(Number.isFinite(actual)&&actual>=0){ledger.spentUsd+=actual;state.spentUsd+=actual;}
          const priorHomes=[...(protocol.lineage.priorHomes??[]),...(Object.values(ledger.arms) as any[]).map(state=>state.home)].filter(path=>path!==home);
          const toolAccesses=message.content.filter(c=>c.type==='toolCall').map(c=>auditToolAccess(c.name,c.arguments,home,root,priorHomes));
          Object.assign(entry,{chargedUsd:keep,costUsd:actual,usage:message.usage,stopReason:message.stopReason,servedModel:message.model,toolCalls:toolAccesses.length,toolAccesses,format:{contentTypes:message.content.map(c=>c.type),textCharacters:message.content.reduce((n,c)=>n+(c.type==='text'?c.text.length:0),0)},finishedAt:new Date().toISOString()});
          writeAtomic(join(privateDir,`response-${ledger.calls.indexOf(entry)}.json`),JSON.stringify(message,null,2),{mode:0o600});persist();
          if(message.model!==model.id)control.cancel('Unexpected served model');
          if(ledger.chargedUsd>CAPS.total||state.chargedUsd>armCap)control.cancel('Accounting cap');
        },error=>{if(!dispatched)charge(-reserve);Object.assign(entry,{error:String(error),chargedUsd:dispatched?reserve:0});persist();control.cancel('Provider failure; unknown reservation retained');});
        pending.add(done);void done.finally(()=>pending.delete(done));return stream;
      };
      const timer=setTimeout(()=>control.cancel('Original logical arm wall cap'),wallMs);const start=Date.now();
      let project=workerProject(home,arm);
      try {
        if(arm==='simple') {
          const recordRun=runPaths(home,'simple'),record=new RunRecord(recordRun.record),ctx={cwd:project,roots:[project],run:recordRun,record,bashTimeoutMs:120000};
          const model=getBundledModel('anthropic','claude-fable-5-1')!;
          const agent=new Agent({initialState:{model,thinkingLevel:'xhigh' as any,systemPrompt:[`Implement the user's task in ${project}. Use the provided read, write, edit and bash tools. Run your tests and report completion.`],tools:[readTool(ctx),writeTool(ctx),editTool(ctx),bashTool(ctx)]},streamFn:capped,getApiKey:()=>runtime.apiKeyFor('anthropic')});
          control.signal.addEventListener('abort',()=>agent.abort(),{once:true});
          await withRunControl(control,()=>agent.prompt(task.prompt));
          const final=agent.state.messages.filter((m:any)=>m.role==='assistant').at(-1) as any;
          state.completed=!control.signal.aborted&&final?.stopReason==='stop';
          writeAtomic(join(privateDir,'agent-messages.json'),JSON.stringify(agent.state.messages,null,2),{mode:0o600});
        } else {
          const output:string[]=[],errors:string[]=[];
          const command=recovery?['run','resume','paired']:['run','new',task.prompt,'--id','paired'];
          const code=await withRunControl(control,()=>main([...command,'--home',home,'--through','reflect','--yes','--autonomous','--json'],{write:t=>output.push(t),error:t=>errors.push(t)},{apiKeyFor:runtime.apiKeyFor,fetchUsage:runtime.fetchUsage,streamFn:capped,onRun:active=>{
            const workflow=assertDirectWorkflow(active),routing=assertPairedRouting(loadFrozenRouting(active));
            if(recovery)assertRecoverySnapshot(recovery,true);
            state.preflight={workflow,routing};preflight=true;persist();
          }}));
          const status=readStatus(runPaths(home,'paired'));Object.assign(state,{code,status,output,errors});state.completed=code===0&&status.state==='done'&&status.outcome?.kind==='success';project=status.projectDir??project;
        }
      } catch(error){state.error=String(error);state.completed=false;}
      finally{clearTimeout(timer);await Promise.allSettled([...pending]);state.elapsedMs=Date.now()-start;state.completed=state.completed&&!control.signal.aborted;}
      if(arm==='full') {
        const active=runPaths(home,'paired');
        const status=existsSync(active.status)?readStatus(active):undefined;
        const events=existsSync(active.record)?new RunRecord(active.record).read():[];
        Object.assign(state,phaseCompletion(status,events));
        if(recovery){state.resumedPhaseEnds=events.slice(recovery.initialEventCount).filter(event=>event.t==='phase.end');state.immutableArtifactsPreserved=JSON.stringify(immutableRecoveryFiles(home))===JSON.stringify(recovery.immutableFiles);}
      } else Object.assign(state,{deliverySucceeded:state.completed,reflectionSucceeded:null,allRequestedStagesSucceeded:state.completed});
      state.project=project;state.artifactDirectory=artifactDirectory(project,arm);
      state.cumulativeLogicalSpentUsd=state.spentUsd+(recovery?.priorSpentUsd??0);state.cumulativeLogicalChargedUsd=state.chargedUsd+(recovery?.priorChargedUsd??0);state.cumulativeLogicalElapsedMs=state.elapsedMs+(recovery?.priorElapsedMs??0);
      const calls=ledger.calls.filter((call:any)=>call.arm===key);
      state.providerFailures=calls.filter((call:any)=>call.error||['error','aborted'].includes(call.stopReason)).length;
      state.toolCalls=calls.reduce((n:number,call:any)=>n+(call.toolCalls??0),0);
      state.modelCalls=calls.length;state.servedModels=[...new Set(calls.map((call:any)=>call.servedModel))];
      state.accessFlags=calls.flatMap((call:any)=>call.toolAccesses??[]).filter((access:any)=>access.flags.length);
      state.contaminationObserved=state.accessFlags.some((access:any)=>access.flags.some((flag:string)=>['evaluator-or-oracle-reference','prior-arm-access'].includes(flag)));
      state.independentSourceAudit='pending-parent-review';
      state.finishedAt=new Date().toISOString();persist();console.log(JSON.stringify({arm:key,completed:state.completed,taskSuccess:state.taskSuccess,chargedUsd:state.chargedUsd,spentUsd:state.spentUsd,elapsedMs:state.elapsedMs}));
    }
    // No oracle fixtures or grade results are materialized until both model arms have stopped.
    for(const arm of arms) {
      const key=`${taskId}/${arm}`,state=ledger.arms[key],oracleRoot=join(root,'grading',taskId,arm);mkdirSync(oracleRoot,{recursive:true});
      try{state.grade=await gradeProject(taskId,safeProject(state.home,state.artifactDirectory),oracleRoot);}catch(error){state.gradingError=String(error);}
      state.artifactCorrect=Boolean(state.grade?.allOraclePass&&state.grade?.readmePresent&&state.grade?.modelTests.pass);
      if(state.recovery) {
        try{state.immutableArtifactsPreserved=state.immutableArtifactsPreserved&&JSON.stringify(immutableRecoveryFiles(state.home))===JSON.stringify(state.recovery.immutableFiles);}
        catch{state.immutableArtifactsPreserved=false;}
      }
      state.taskSuccess=qualifiedTaskSuccess(state);
      persist();console.log(JSON.stringify({arm:key,completed:state.completed,artifactCorrect:state.artifactCorrect,taskSuccess:state.taskSuccess,sourceAudit:state.independentSourceAudit}));
    }
  } finally { release(); }
}
if(import.meta.main){
  const arg=(name:string)=>Bun.argv[Bun.argv.indexOf(name)+1];
  if(Bun.argv.includes('--prepare'))prepare(Bun.argv.includes('--resume-existing'));
  else if(Bun.argv.includes('--run')&&Bun.argv.includes('--task')){await run(resolve(arg('--run')!),arg('--task')!,Bun.argv.includes('--arm')?arg('--arm'):undefined);await finishProcess(0);}
  else throw new Error('Use --prepare or --run ROOT --task csv-total --confirm-spend');
}
