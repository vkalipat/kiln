import { createResearchClassifier } from '../../../src/operator/research-classify.ts';
import { writeFileSync } from 'node:fs';
const rows=[];
for(const setup of [{sources:6,fields:4,questionChars:80,fieldQuestionChars:80,sourceChars:12000},{sources:12,fields:12,questionChars:4096,fieldQuestionChars:1024,sourceChars:12000}]){
 let calls=0,active=0,peak=0;const service={evaluate:async()=>{calls++;active++;peak=Math.max(peak,active);await Bun.sleep(1);active--;return {source:'fallback',reason:'disabled',costUsd:0}}};
 const classify=createResearchClassifier(service as any,'synthetic');const result=await classify({question:'q'.repeat(setup.questionChars),fields:Array.from({length:setup.fields},(_,i)=>({id:`f${i}`,question:'q'.repeat(setup.fieldQuestionChars)})),passages:Array.from({length:setup.sources},(_,i)=>({id:`p${i}`,sourceId:`s${i}`,text:'x'.repeat(setup.sourceChars),start:0,end:setup.sourceChars}))},new AbortController().signal);
 rows.push({...setup,classificationCalls:calls,peakConcurrentClassifications:peak,labels:result.labels.length});
}
console.log(JSON.stringify({rows},null,2));writeFileSync('/tmp/kiln-audit-capacity-20261004.json',JSON.stringify({rows},null,2)+'\n');
