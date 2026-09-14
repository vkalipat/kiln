import {test,expect} from 'bun:test';
import {outputAllowance,serializableConfig,assertDirectWorkflow,DELIVERY_SEED} from '../../scripts/benchmarks/delivery-validation';
import {defaultConfig} from '../../src/core/config';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initHome} from '../../src/core/home';
import {saveConfig} from '../../src/core/config';
import {main} from '../../src/cli/main';
import {getBundledModel} from '@oh-my-pi/pi-catalog';
test('long output allowance follows critic/auditor decision tools',()=>{
  expect(outputAllowance([{name:'critique'}])).toBe(32768);
  expect(outputAllowance([{name:'audit'}])).toBe(32768);
  expect(outputAllowance([{name:'write'},{name:'bash'}])).toBe(16384);
  expect(outputAllowance()).toBe(16384);
});
test('real CLI onRun validates direct path before any phase provider call',async()=>{
  for(const disabled of [false,true]){
    const home=mkdtempSync(join(tmpdir(),'kiln-delivery-preflight-test-'));initHome(home,{plugAndPlay:true});
    const cfg=defaultConfig();cfg.routing={mode:'adaptive'};saveConfig(home,cfg);
    let calls=0,validated=false;const end=new Error('test ends before phase dispatch'),errors:string[]=[];
    const attempt=main(['run','new',DELIVERY_SEED,'--id','preflight','--home',home,'--through','reflect','--autonomous','--yes','--json'],{write:()=>{},error:t=>errors.push(t)},{
      models:{brain:getBundledModel('anthropic','claude-fable-5-1')!},apiKeyFor:async()=> 'mock',adaptiveWorkflow:true,
      ...(disabled?{runtimeEffort:{enabled:false}}:{}),
      streamFn:()=>{calls++;throw new Error('unexpected provider call');},
      onRun:run=>{assertDirectWorkflow(run);validated=true;throw end;}
    });
    expect(await attempt).not.toBe(0);
    expect(errors.join('')).toContain(disabled?'persisted direct adaptive workflow':'test ends before phase dispatch');
    expect(validated).toBe(!disabled);expect(calls).toBe(0);
  }
});
test('config snapshot omits runtime methods and is detached from later mutation',()=>{
  const cfg=defaultConfig();
  const snapshot=serializableConfig(cfg);
  expect(typeof cfg.budgets.phaseBudgetUsd).toBe('function');
  expect(snapshot.budgets.phaseBudgetUsd).toBeUndefined();
  expect(snapshot.budgets.phaseBudgetWallSeconds).toBeUndefined();
  expect(snapshot.budgets.usd).toBe(cfg.budgets.usd);
  const originalUsd=snapshot.budgets.usd;
  cfg.budgets.usd=originalUsd+1;
  expect(snapshot.budgets.usd).toBe(originalUsd);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});
