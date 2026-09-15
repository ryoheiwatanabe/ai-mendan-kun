import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runGroundedEvaluation } from '../scripts/grounded-eval.ts';
import type { AnswerProvider } from '../lib/types.ts';
import type { answer } from '../lib/answer/engine.ts';

const payload = {segments: [], answerability: 'answerable' as const, confidence: 'high' as const};
async function records(result: Awaited<ReturnType<typeof runGroundedEvaluation>>) {
  const path = join(result.outputDirectory, `${result.runId}.ndjson`);
  try { return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  finally { await rm(path); await rm(result.summaryPath); }
}

test('評価は生成と校閲を分け、ケース間でusageを混ぜず、本文を変形しない', async () => {
  let calls = 0;
  const provider: AnswerProvider = {async *stream(input) {
    calls++;
    yield {type:'complete', payload, usage: input.purpose === 'verify' ? {input:5,output:7} : {input:2,output:3}};
  }};
  const engine: typeof answer = async function* (input, deps, signal) {
    for await (const _ of deps.provider.stream({question:input.message,history:[],evidence:[],highRisk:false},signal)) { /* consume */ }
    for await (const _ of deps.provider.stream({question:input.message,history:[],evidence:[],highRisk:false,purpose:'verify'},signal)) { /* consume */ }
    yield {type:'text',text:'前半',answerId:'test'};
    yield {type:'text',text:'\n後半',answerId:'test'};
    yield {type:'done',answerId:'test',answerability:'answerable',latencyMs:1,firstTextMs:1};
  };
  const rows=await records(await runGroundedEvaluation({provider,engine,cases:['case-02','case-03'],variantIndices:[2],label:'test-meter'}));
  assert.equal(calls,4); assert.equal(rows.length,2);
  for (const row of rows) {
    assert.deepEqual(row.callCounts,{stream:1,verify:1});
    assert.deepEqual(row.usage,{input:7,output:10});
    assert.deepEqual(row.usageByCallKind.verify,{input:5,output:7});
    assert.equal(row.answerText,'前半\n後半');
    assert.equal(row.variant,2);
    assert.equal(row.semanticReview,'pending');
  }
});

test('評価は3回目の生成を呼ぶ前に止め、失敗後の質問へ進まない', async () => {
  let calls=0;
  const provider: AnswerProvider={async *stream(){calls++;yield {type:'complete',payload};}};
  const engine:typeof answer=async function* (input,deps,signal){
    for(let i=0;i<3;i++)for await(const _ of deps.provider.stream({question:input.message,history:[],evidence:[],highRisk:false},signal)){ /* consume */ }
    yield {type:'done',answerId:'test',answerability:'answerable',latencyMs:1,firstTextMs:null};
  };
  const rows=await records(await runGroundedEvaluation({provider,engine,cases:['case-02','case-03'],label:'test-fail-stop'}));
  assert.equal(calls,2);assert.equal(rows.length,1);assert.equal(rows[0].errorCode,'model_call_limit');assert.equal(rows[0].usage,'unknown');
});

test('一括診断モードも通信・生成エラーでは止め、品質拒否だけ次の独立質問へ進む', async () => {
  const provider:AnswerProvider={async *stream(){yield {type:'complete',payload};}};
  for(const code of ['verification_rejected','generation_error'] as const){
    const engine:typeof answer=async function* (_input,deps){
      deps.diagnostics?.({code});
      yield {type:'error',code:'processing_failure',message:'処理失敗'};
    };
    const rows=await records(await runGroundedEvaluation({provider,engine,cases:['case-02','case-03'],label:'test-batch-failure',continueOnFailure:true}));
    assert.equal(rows.length,code==='verification_rejected'?2:1);
  }
});
