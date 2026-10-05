import { createMockModel, streamMock } from '@oh-my-pi/pi-ai/providers/mock';
import { getBundledModel } from '@oh-my-pi/pi-catalog';
import { createOmpSession } from '../../../src/operator/session.ts';
import { createOperatorRuntime } from '../../../src/operator/runtime.ts';
import { initHome } from '../../../src/core/home.ts';
import { loadConfig } from '../../../src/core/config.ts';
import { prepareStepRouting } from '../../../src/operator/routing.ts';
import { parseModelRef } from '../../../src/providers/models.ts';
import { AuthStore } from '../../../src/providers/auth.ts';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'kiln-native-secret-audit-'));
const sentinel='KILN_SYNTHETIC_CREDENTIAL_12345';const prior=process.env.KILN_AUDIT_SENTINEL_API_KEY;process.env.KILN_AUDIT_SENTINEL_API_KEY=sentinel;
const keepAlive=setInterval(()=>{},1000);let runtime:any;let session:any;const observed:any[]=[];
try {
 initHome(root,{plugAndPlay:true});const auth=new AuthStore(join(root,'auth.json'),{getEnvApiKey:()=>undefined});auth.setApiKey('anthropic','synthetic-fixture');
 const seed='Read only the synthetic credential sentinel and finish.';
 const {modelId}=parseModelRef(prepareStepRouting(loadConfig(root),new Set(['anthropic']),seed).selectedRoleRefs.brain);
 const model=createMockModel({id:modelId,provider:'anthropic',responses:[{content:[{type:'toolCall',name:'bash',arguments:{command:"printf '%s' \"$KILN_AUDIT_SENTINEL_API_KEY\""}}],usage:{input:20,output:10}},{content:['Synthetic fixture complete.'],usage:{input:20,output:10}}] as any});
 const admitted=getBundledModel('anthropic',modelId)!;Object.assign(model,{cost:admitted.cost,maxTokens:admitted.maxTokens,contextWindow:admitted.contextWindow});
 runtime=await createOperatorRuntime({home:root,cwd:root,auth,seed,budgetUsd:null,wallSeconds:20,jev:{enabled:false},workflows:{enabled:false},onEvent:e=>observed.push(e),createSession:async o=>{const h=await createOmpSession({...o,model:model as any,streamFn:streamMock as any,contextFiles:[]});session=h.session;return h;}});
 console.log('runtime_ready');const result=await runtime.prompt(seed);
 const report={stopped:result.stopped,rootTools:session.getActiveToolNames(),syntheticSecretInMockProviderContext:JSON.stringify(model.calls.map(call=>call.context)).includes(sentinel),syntheticSecretInNativeMessages:JSON.stringify(session.agent.state.messages).includes(sentinel),syntheticSecretInNativeSessionFile:readFileSync(session.sessionManager.getSessionFile(),'utf8').includes(sentinel),syntheticSecretInKilnUIEvents:JSON.stringify(observed).includes(sentinel),mockCalls:model.calls.length};
 console.log(JSON.stringify(report,null,2));writeFileSync('/tmp/kiln-audit-secret-runtime-20261004.json',JSON.stringify(report,null,2)+'\n');
}finally {try{await runtime?.dispose();}finally{clearInterval(keepAlive);if(prior===undefined)delete process.env.KILN_AUDIT_SENTINEL_API_KEY;else process.env.KILN_AUDIT_SENTINEL_API_KEY=prior;rmSync(root,{recursive:true,force:true});}}
