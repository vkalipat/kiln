import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, realpathSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPS, TASKS, ORACLES, gradeProject, safeProject, assertPairedRouting, normalExit, validateLedger, lockedLedger, auditToolAccess, preflightTaskRoutes, workerProject, artifactDirectory, selectedArms, phaseCompletion, lineageHomes, dependencyPreflight, recoveryLimits, immutableRecoveryFiles } from '../../scripts/benchmarks/paired-completion';
import { checkNeeds } from '../../src/ideation/probe';
import { CAMPAIGN } from '../../scripts/benchmarks/paired-completion';
import { withRecoveryLock, assertRecoveryHistory, qualifiedTaskSuccess } from '../../scripts/benchmarks/paired-completion';
import { createHash } from 'node:crypto';
import { initHome } from '../../src/core/home';
import { createRun, runPaths } from '../../src/core/run';
import { materializeProjectPath } from '../../src/formation/paths';
import { writeAtomic } from '../../src/core/paths';
import { outputAllowance } from '../../scripts/benchmarks/delivery-validation';
import { reservation, settleReservation } from '../../scripts/benchmarks/delivery-recovery-pilot';

describe('paired completion frozen protocol (zero provider calls)',()=>{
  test('snapshot uses native worker lock and checks history under reacquired lock',()=>{
    const home=mkdtempSync(join(tmpdir(),'paired-recovery-lock-test-'));createRun(home,'seed',{id:'paired',exclusive:true});
    const digest=(text:string)=>createHash('sha256').update(text).digest('hex'),run=runPaths(home,'paired');
    writeAtomic(run.status,'status');writeAtomic(run.record,'record');
    const snapshot={home,initialStatusHash:digest('status'),initialRecordHash:digest('record')};
    withRecoveryLock(home,()=>{expect(()=>withRecoveryLock(home,()=>undefined)).toThrow();expect(()=>assertRecoveryHistory(snapshot)).not.toThrow();});
    writeAtomic(run.record,'record changed');withRecoveryLock(home,()=>expect(()=>assertRecoveryHistory(snapshot)).toThrow(/history changed/));
    writeAtomic(run.record,'record');writeAtomic(run.status,'status changed');withRecoveryLock(home,()=>expect(()=>assertRecoveryHistory(snapshot)).toThrow(/history changed/));
  });
  test('last-tool immutable tampering disqualifies otherwise passing recovery',()=>{
    const state={completed:true,artifactCorrect:true,contaminationObserved:false,recovery:{},immutableArtifactsPreserved:true};
    expect(qualifiedTaskSuccess(state)).toBe(true);expect(qualifiedTaskSuccess({...state,immutableArtifactsPreserved:false})).toBe(false);expect(qualifiedTaskSuccess({...state,immutableArtifactsPreserved:undefined})).toBe(false);
  });
  test('recovery retains original logical cost and active wall allowance',()=>{
    const limits=recoveryLimits(3.93711425,798121);expect(limits.usd).toBeCloseTo(6.06288575,8);expect(limits.wallMs).toBe(701879);
    expect(()=>recoveryLimits(10,100)).toThrow();expect(()=>recoveryLimits(1,1500000)).toThrow();expect(()=>recoveryLimits(NaN,0)).toThrow();
    expect(CAMPAIGN.priorRecordedUsd+CAMPAIGN.retainedUncertaintyUsd+CAMPAIGN.separateIdeationReservationUsd+CAPS.total).toBeCloseTo(CAMPAIGN.maximumAccountedUsd,8);
    expect(CAMPAIGN.maximumAccountedUsd).toBeLessThan(CAMPAIGN.hardCapUsd);
  });
  test('immutable recovery snapshot is read-only and detects artifact drift',()=>{
    const home=mkdtempSync(join(tmpdir(),'paired-recovery-files-test-'));
    for(const path of ['config.json','runs/paired/seed.md','runs/paired/workflow.json','runs/paired/routing.json','runs/paired/features.json','runs/paired/acceptance.lock','runs/paired/project/spec.md','runs/paired/project/init.sh','runs/paired/project/project.json','runs/paired/project/features.json','runs/paired/project/acceptance.lock'])writeAtomic(join(home,path),'fixed');
    const before=immutableRecoveryFiles(home);expect(immutableRecoveryFiles(home)).toEqual(before);
    writeAtomic(join(home,'runs/paired/project/spec.md'),'changed');expect(immutableRecoveryFiles(home)).not.toEqual(before);
  });
  test('delivery and optional reflection success remain separate',()=>{
    const status={state:'done',outcome:{kind:'success'}},events=['frame','form','build'].map(phase=>({t:'phase.end',phase,outcome:'ok'}));
    const partial=phaseCompletion(status,[...events,{t:'phase.end',phase:'reflect',outcome:'failed'}]);expect(partial.deliverySucceeded).toBe(true);expect(partial.reflectionSucceeded).toBe(false);expect(partial.allRequestedStagesSucceeded).toBe(false);
    expect(phaseCompletion(status,[...events,{t:'phase.end',phase:'reflect',outcome:'ok'}]).allRequestedStagesSucceeded).toBe(true);
  });
  test('all controller lineage homes participate in access audit',()=>{
    const root=mkdtempSync(join(tmpdir(),'paired-lineage-test-')),home=mkdtempSync(join(tmpdir(),'paired-current-test-'));
    writeAtomic(join(root,'ledger.json'),JSON.stringify({arms:{simple:{home:'/old-simple-home'},full:{home:'/old-full-home'}}}));
    const homes=lineageHomes([root]);expect(homes).toEqual(['/old-simple-home','/old-full-home']);
    expect(auditToolAccess('read',{path:'/old-simple-home/project/slugify.py'},home,root,homes).flags).toContain('prior-arm-access');
  });
  test('native dependency prerequisite uses executable tokens, not prose',()=>{
    expect(()=>dependencyPreflight()).not.toThrow();
    expect(checkNeeds(['python3'])).toEqual([]);
    expect(checkNeeds(['python3 (CPython 3.8 or newer) on PATH; standard library only, no pip, no network'])).not.toEqual([]);
  });
  test('native default project respects exclusive reservation and grader uses builder repo',()=>{
    const home=mkdtempSync(join(tmpdir(),'paired-native-path-test-'));initHome(home,{plugAndPlay:true});
    const project=workerProject(home,'full');expect(project).toBe(runPaths(home,'paired').project);
    expect(existsSync(runPaths(home,'paired').dir)).toBe(false);expect(existsSync(project)).toBe(false);
    const run=createRun(home,TASKS[0].prompt,{id:'paired',exclusive:true});
    expect(()=>createRun(home,TASKS[0].prompt,{id:'paired',exclusive:true})).toThrow();
    expect(()=>materializeProjectPath(run,join(home,'project'),{ideaId:'supplied-task'})).toThrow(/inside the kiln home/);
    const paths=materializeProjectPath(run,undefined,{ideaId:'supplied-task'});expect(paths.dir).toBe(project);expect(artifactDirectory(project,'full')).toBe(paths.repo);
    expect(existsSync(workerProject(home,'simple'))).toBe(true);
  });
  test('CSV-only prospective order funds simple baseline first and forbids slugify reruns',()=>{
    expect(()=>selectedArms('slugify','full')).toThrow();expect(()=>selectedArms('slugify')).toThrow();
    expect(selectedArms('csv-total')).toEqual(['simple','full']);expect(()=>selectedArms('csv-total','full')).toThrow();
    expect(CAPS.total).toBe(9);expect(CAPS.simple).toBe(3);
  });
  test('both exact task contracts pass native route preflight before any arm',()=>{
    const routes=preflightTaskRoutes();expect(routes.length).toBe(2);
    for(const route of routes){expect(route.plan.intent).toBe('supplied_concept');expect(route.plan.strategy?.mode).toBe('direct');expect(route.execution.phases).toEqual(['frame','form','build','reflect']);}
  });
  test('preflight fails closed on model and effort mismatches',()=>{
    const routing:any={roles:{brain:['anthropic/claude-fable-5-1'],builder:['anthropic/claude-fable-5-1'],critic:['anthropic/claude-opus-5'],auditor:['anthropic/claude-opus-5']},effort:'xhigh'};
    expect(assertPairedRouting(routing)).toBe(routing);
    expect(()=>assertPairedRouting(undefined)).toThrow();
    expect(()=>assertPairedRouting({...routing,effectiveEffort:{builder:'high'}})).toThrow();
    expect(()=>assertPairedRouting({...routing,effectiveEffort:{critic:'high'}})).toThrow();
    expect(()=>assertPairedRouting({...routing,effectiveEffort:{auditor:'high'}})).toThrow();
    expect(()=>assertPairedRouting({...routing,roles:{...routing.roles,auditor:['anthropic/claude-fable-5-1']}})).toThrow();
  });
  test('ledger lock precedes snapshot read and invalid accounting fails closed',()=>{
    const root=mkdtempSync(join(tmpdir(),'paired-lock-test-'));writeAtomic(join(root,'ledger.json'),'invalid-json');
    const fd=openSync(join(root,'execution.lock'),'wx');
    expect(()=>lockedLedger(root)).toThrow(/EEXIST/);
    closeSync(fd);unlinkSync(join(root,'execution.lock'));
    expect(()=>lockedLedger(root)).toThrow();
    for(const value of [NaN,Infinity,-1,null])expect(()=>validateLedger({chargedUsd:value,spentUsd:0,calls:[],arms:{}})).toThrow();
    writeAtomic(join(root,'ledger.json'),JSON.stringify({chargedUsd:1,spentUsd:0,calls:[],arms:{a:{chargedUsd:1,spentUsd:0}}}));
    const locked=lockedLedger(root);expect(locked.ledger.chargedUsd).toBe(1);locked.release();
  });
  test('tool arguments flag evaluator, prior-arm and outside-root access',()=>{
    const home=mkdtempSync(join(tmpdir(),'paired-access-test-')),prior=mkdtempSync(join(tmpdir(),'paired-prior-test-'));
    expect(auditToolAccess('read',{path:'slugify.py'},home,'/controller').flags).toEqual([]);
    expect(auditToolAccess('read',{path:'/controller/prepared-runner.ts'},home,'/controller').flags).toContain('evaluator-or-oracle-reference');
    expect(auditToolAccess('bash',{command:`ls ${prior}`},home,'/controller',[prior]).flags).toContain('prior-arm-access');
    expect(auditToolAccess('read',{path:'../../elsewhere'},home,'/controller').flags).toContain('outside-arm-path');
  });
  test('timeouts and signal deaths never satisfy rejection oracles',async()=>{
    expect(normalExit(143,'SIGTERM')).toBe(false);expect(normalExit(143,null)).toBe(true);expect(normalExit(200,null)).toBe(true);expect(normalExit(2,null)).toBe(true);
    const root=mkdtempSync(join(tmpdir(),'paired-timeout-test-')),project=join(root,'project'),oracle=join(root,'oracle');mkdirSync(project);mkdirSync(oracle);
    writeAtomic(join(project,'slugify.py'),'import time\ntime.sleep(10)\n');
    const result=await gradeProject('slugify',project,oracle,30);
    expect(result.results.every(r=>!r.pass)).toBe(true);
    expect(result.results.some(r=>Boolean(r.signal)||r.code>=128)).toBe(true);
  });
  test('bounded allocation and uniform output ceilings',()=>{
    expect(CAPS.simple).toBeLessThan(CAPS.total);expect(CAPS.full).toBe(CAPS.total);
    expect(outputAllowance([{name:'bash'}])).toBe(16384);
    expect(outputAllowance([{name:'critique'}])).toBe(32768);
    expect(outputAllowance([{name:'audit'}])).toBe(32768);
    const reserve=reservation({input:5,output:25,cacheRead:0.5,cacheWrite:6.25},1000,16384);
    expect(reserve).toBeGreaterThan(0.4);
    expect(settleReservation(reserve,0,'error')).toBe(reserve);
    expect(settleReservation(reserve,NaN,'stop')).toBe(reserve);
  });
  test('contracts define exact evaluator behavior before generation',()=>{
    expect(TASKS.map(t=>t.id)).toEqual(['slugify','csv-total']);
    expect(TASKS[0].prompt).toContain('NFKD');
    expect(TASKS[1].prompt).toContain('exact decimal arithmetic');
    expect(TASKS[1].prompt).toContain('no partial stdout');
    expect(ORACLES['csv-total']!.some(c=>c.name==='large-precision')).toBe(true);
    for(const task of TASKS){expect(ORACLES[task.id]!.some(c=>c.fails)).toBe(true);expect(ORACLES[task.id]!.some(c=>!c.fails)).toBe(true);}
  });
  test('project grading rejects sibling and symlink escapes',()=>{
    const root=mkdtempSync(join(tmpdir(),'paired-path-test-')),inside=join(root,'project');mkdirSync(inside);
    expect(safeProject(root,inside)).toBe(realpathSync(inside));
    expect(()=>safeProject(root,root)).toThrow();
    const outside=mkdtempSync(join(tmpdir(),'paired-path-outside-'));symlinkSync(outside,join(root,'escape'));
    expect(()=>safeProject(root,join(root,'escape'))).toThrow();
  });
  test('real subprocess oracle grades slug implementation and detects broken output',async()=>{
    const root=mkdtempSync(join(tmpdir(),'paired-grader-test-')),project=join(root,'project'),oracle=join(root,'oracle');mkdirSync(project);mkdirSync(oracle);
    // Evaluator unit fixture only; never a model prediction or performance sample.
    writeAtomic(join(project,'slugify.py'),`import sys,re,unicodedata\nif len(sys.argv)!=2: sys.exit(2)\ns=re.sub('[^a-z0-9]+','-',unicodedata.normalize('NFKD',sys.argv[1]).encode('ascii','ignore').decode().lower()).strip('-')\nif not s: sys.exit(1)\nprint(s)\n`);
    writeAtomic(join(project,'README.md'),'Usage: python3 slugify.py TEXT\n');
    writeAtomic(join(project,'test_cli.py'),'import unittest\nclass TestSmoke(unittest.TestCase):\n def test_true(self): self.assertTrue(True)\n');
    const good=await gradeProject('slugify',project,oracle);expect(good.allOraclePass).toBe(true);expect(good.modelTests.count).toBe(1);
    writeAtomic(join(project,'slugify.py'),"print('wrong')\n");
    expect((await gradeProject('slugify',project,oracle)).allOraclePass).toBe(false);
  });
  test('missing implementation cannot pass by failing every invocation',async()=>{
    const root=mkdtempSync(join(tmpdir(),'paired-missing-test-')),project=join(root,'project'),oracle=join(root,'oracle');mkdirSync(project);mkdirSync(oracle);
    const result=await gradeProject('csv-total',project,oracle);
    expect(result.allOraclePass).toBe(false);expect(result.modelTests.pass).toBe(false);expect(result.readmePresent).toBe(false);
  });
});
