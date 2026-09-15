import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerification } from '../lib/ai/verification.ts';
import { GeminiProvider } from '../lib/ai/gemini.ts';
import { OpenAIProvider } from '../lib/ai/openai.ts';
import { AnthropicProvider } from '../lib/ai/anthropic.ts';
import type { ModelPayload } from '../lib/types.ts';

const candidate: ModelPayload = { segments: [{ kind: 'fact', text: '試作を担当しました。', evidenceIds: ['e1'] }], answerability: 'answerable', confidence: 'high' };

test('短い校閲判定は厳密なtrueと理由の一致を要求し、候補を複製して返す', () => {
  const result = parseVerification({ accepted: true, reason: 'accepted' }, candidate);
  assert.deepEqual(result.payload, candidate);
  assert.notEqual(result.payload, candidate);
  for (const raw of [{ accepted: 'true', reason: 'accepted' }, { accepted: true, reason: 'unsupported_claim' },
    { accepted: true }, { accepted: true, reason: 'accepted', text: '改変' }, { accepted: false, reason: 'arbitrary' }])
    assert.throws(() => parseVerification(raw, candidate), /invalid_verification_payload/);
  assert.throws(() => parseVerification({ accepted: true, reason: 'accepted' }), /invalid_verification_payload/);
  assert.deepEqual(parseVerification({ accepted: false, reason: 'unsupported_claim' }, candidate).payload?.segments, []);
});

test('全providerで短い判定JSONだけを受け取り、承認時のみ元候補を返す', async t => {
  for (const vendor of ['gemini', 'openai', 'anthropic'] as const) {
    for (const accepted of [true, false]) {
      const json = JSON.stringify({ accepted, reason: accepted ? 'accepted' : 'unsupported_claim' });
      const wire = vendor === 'gemini' ? [{ candidates: [{ content: { parts: [{ text: json }] }, finishReason: 'STOP' }] }]
        : vendor === 'openai' ? [{ choices: [{ delta: { content: json }, finish_reason: 'stop' }] }]
        : [{ type: 'message_start', message: { role: 'assistant', content: [], stop_reason: null } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json } },
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
      const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const schema = vendor === 'gemini' ? body.generationConfig.responseJsonSchema
          : vendor === 'openai' ? body.response_format.json_schema.schema : body.output_config.format.schema;
        assert.deepEqual(Object.keys(schema.properties).sort(), ['accepted', 'reason']);
        return new Response(wire.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      });
      try {
        const provider = vendor === 'gemini' ? new GeminiProvider('test-key') : vendor === 'openai' ? new OpenAIProvider('test-key') : new AnthropicProvider('test-key');
        const events = await Array.fromAsync(provider.stream({ question: '担当は？', history: [], evidence: [], highRisk: false, purpose: 'verify', candidate }, new AbortController().signal));
        assert.equal(events.length, 1);
        const end = events[0];
        assert.equal(end.type, 'complete');
        if (end.type === 'complete') assert.deepEqual(end.payload, accepted ? candidate : { segments: [], answerability: 'unknown', confidence: 'low' });
      } finally { mock.mock.restore(); }
    }
  }
});
