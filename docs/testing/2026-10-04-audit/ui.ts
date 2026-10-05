import { TranscriptView } from '../../../src/tui/transcript.ts';
import { PromptBox } from '../../../src/tui/promptbox.ts';
import { renderAppLayout } from '../../../src/tui/layout.ts';
import { AuthInput } from '../../../src/tui/auth-input.ts';
import { EffortDial } from '../../../src/tui/dial.ts';
import { PALETTE_COMMANDS } from '../../../src/tui/palette.ts';
import { visibleWidth } from '@oh-my-pi/pi-tui';
import { writeFileSync } from 'node:fs';
const entries:any[]=[{id:'u',kind:'user',text:'Implement and check the CSV importer. 🧪 Preserve malformed rows.'},{id:'a',kind:'brain',text:'I checked the parser and found two cases.\n\n| Input | Result |\n| --- | --- |\n| empty | retained |\n| malformed | reported |\n\n```ts\nparse("one,two");\n```'},{id:'t',kind:'tool',verb:'bash',status:'done',args:'bun test',body:'All synthetic fixture checks passed.'}];
const report:any={matrix:[],paletteMissing:{nativeNewSession:!PALETTE_COMMANDS.some(c=>c.argv[0]==='task'),autoEffort:!PALETTE_COMMANDS.some(c=>c.argv.join(' ')==='mode set auto'),computeMonitor:!PALETTE_COMMANDS.some(c=>c.argv.join(' ')==='task monitor'),integrations:!PALETTE_COMMANDS.some(c=>c.argv[0]==='integrations')}};let screens='';
for(const [w,h] of [[20,10],[40,12],[80,24],[120,40]]){
 const snapshot:any={phase:'build',state:'idle',runId:'synthetic',mode:'operator',costUsd:0.05,directory:'/tmp/synthetic-project',effort:'high',routing:{kind:'implement',modelRef:'openai-codex/gpt-6-astra',effort:'high'},transcript:entries,auth:{required:false,configured:[]}};
 const transcript=new TranscriptView(entries);const prompt=new PromptBox({status:snapshot});const lines=renderAppLayout({width:w,height:h,snapshot,transcript,prompt});
 report.matrix.push({width:w,height:h,rows:lines.length,maxVisibleWidth:Math.max(...lines.map(visibleWidth)),boundsPass:lines.length<=h&&lines.every(x=>visibleWidth(x)<=w)});
 screens+=`Fixture ${w}x${h}\n`+lines.map(x=>Bun.stripANSI(x)).join('\n')+'\n\n';
}
const secret=new AuthInput({prompt:'Synthetic masked input',secret:true,onSubmit:()=>{},onCancel:()=>{}});secret.input.setValue('SYNTHETIC_INPUT_SENTINEL');report.maskedInputHidden=!secret.render(80).join('\n').includes('SYNTHETIC_INPUT_SENTINEL');report.effortChoices=new EffortDial().render(80).map(x=>Bun.stripANSI(x));
writeFileSync('/tmp/kiln-audit-ui-20261004.json',JSON.stringify(report,null,2)+'\n');writeFileSync('/tmp/kiln-audit-ui-20261004.txt',screens);console.log(JSON.stringify(report,null,2));
