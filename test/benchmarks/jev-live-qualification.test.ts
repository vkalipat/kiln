import {expect,test} from 'bun:test';
import {qualificationFixtures,runLiveQualification} from '../../scripts/benchmarks/jev-live-qualification';
test('qualification uses nine synthetic requests and measures labels, accounting and real reuse',async()=>{
  let calls=0;
  const transport=(async(_url:unknown,init?:RequestInit)=>{
    calls++;const body=JSON.parse(String(init?.body));
    const fixture=qualificationFixtures.find(f=>JSON.stringify(f.state)===JSON.stringify(body.state))!;
    expect(fixture).toBeDefined();
    return Response.json({model:body.model,usage:{input_tokens:100,output_tokens:5},answers:Object.fromEntries(Object.keys(body.questions).map(id=>{
      const choice=fixture.expected[id]!;
      return[id,{type:'choice',choice,confidence:0.99,probabilities:Object.fromEntries(Object.keys(body.questions[id].criteria).map(key=>[key,key===choice?1:0]))}];
    }))});
  }) as typeof fetch;
  const report=await runLiveQualification({apiKey:'synthetic-test',fetch:transport});
  expect(calls).toBe(9);expect(report.taskSuccess).toBe(true);expect(report.reuse.success).toBe(true);
  expect(report.usage).toMatchObject({inputTokens:900,outputTokens:45,totalTokens:945,unknownRequests:0,complete:true});
  expect(report.cost.knownUsd).toBeCloseTo(900*0.042/1e6);
  expect(JSON.stringify(report)).not.toContain('synthetic-test');
});
test('missing credential fails before dispatch',async()=>{
  await expect(runLiveQualification({apiKey:''})).rejects.toThrow('required');
});
