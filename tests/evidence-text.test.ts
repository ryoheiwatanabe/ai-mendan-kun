import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateEvidence, visibleEvidenceContent, type Evidence } from '../lib/knowledge/evidence-text.ts';

describe('visibleEvidenceContent', () => {
  it('hides a matched numeric paragraph but keeps independent paragraphs', () => {
    const evidence: Evidence = {
      content: 'Company revenue is $5M.\n\nEmployees work remotely in 2020.\n\nThe CEO is Jane Doe.',
      excludedStatements: ['Employees work remotely in 2020.'],
    };

    assert.equal(visibleEvidenceContent(evidence),
      'Company revenue is $5M.\n\nThe CEO is Jane Doe.'
    );
  });

  it('does not leak negation conditions from a removed paragraph', () => {
    const evidence: Evidence = {
      content:
        'There is no evidence of fraud.\n\nThe audit found no discrepancies.',
      excludedStatements: ['There is no evidence of fraud.'],
    };

    assert.equal(visibleEvidenceContent(evidence),
      'The audit found no discrepancies.'
    );
  });

  it('returns original content when there are no exclusions and does not alter facts', () => {
    const evidence: Evidence = {
      content: 'Fact one is true.\n\nFact two is also true.',
    };

    assert.equal(visibleEvidenceContent(evidence),
      'Fact one is true.\n\nFact two is also true.'
    );
  });
});

describe('truncateEvidence', () => {
  it('上限以内の本文は変更しない', () => {
    assert.equal(truncateEvidence('短い根拠です。', 900), '短い根拠です。');
  });

  it('超えたら段落の切れ目までで切る', () => {
    const content = `${'あ'.repeat(600)}\n\n${'い'.repeat(600)}`;
    assert.equal(truncateEvidence(content, 900), 'あ'.repeat(600));
  });

  it('段落が無ければ文の切れ目までで切る', () => {
    const content = `${'あ'.repeat(400)}。${'い'.repeat(400)}。${'う'.repeat(400)}。`;
    assert.equal(truncateEvidence(content, 900), `${'あ'.repeat(400)}。${'い'.repeat(400)}。`);
  });

  it('浅い切れ目しか無ければ上限どおりで切る', () => {
    const content = `短い。${'あ'.repeat(2000)}`;
    const truncated = truncateEvidence(content, 900);
    assert.equal(Array.from(truncated).length, 900);
    assert.ok(truncated.startsWith('短い。'));
  });

  it('サロゲートペアを1文字として数える', () => {
    const truncated = truncateEvidence('😀'.repeat(1000), 900);
    assert.equal(Array.from(truncated).length, 900);
  });
});

import { setup, fixture, embedding } from './helpers.ts';
import { KnowledgeRepository } from '../lib/knowledge/repository.ts';
import { retrieve } from '../lib/knowledge/retrieval.ts';
import { modelEvidence } from '../lib/ai/prompt.ts';
import { validateSegment } from '../lib/answer/guard.ts';
import test from 'node:test';

test('現在の検索では古い数値の段落だけ隠し、同じ資料の担当説明と原本照合を保持する', async t => {
  const old = '2020年のチームは3人でした。専任者はいませんでした。';
  const independent = '私は問い合わせの整理を担当しました。';
  const { db, vector } = await setup({ ...fixture, content: `# チーム\n\n${old}\n\n${independent}`,
    facts: [{ id: 'past', key: 'team.size', value: '3', statement: old, aliases: ['チーム'], validFrom: '2020-01-01', validTo: '2020-12-31' }] });
  t.after(() => db.close());
  const repository = new KnowledgeRepository(db, fixture.ownerId);
  const result = await retrieve({ question: '現在のチームでの担当は？', history: [], repository, vector, embedding, signal: new AbortController().signal });
  const source = result.evidence.find(item => item.content.includes(independent));
  assert.ok(source);
  assert.ok(source.content.includes(old), '原本は変更しない');
  const exposed = modelEvidence([source])[0].content;
  assert.ok(exposed.includes(independent));
  assert.ok(!exposed.includes('3人') && !exposed.includes('専任者'));
  assert.equal(await repository.revalidate([source]), true);
  assert.equal(await repository.revalidateSnapshot([source]), true);
  assert.equal(validateSegment({ kind: 'fact', text: independent, evidenceIds: [source.id] }, [source]).ok, true);
  assert.equal(validateSegment({ kind: 'fact', text: old, evidenceIds: [source.id] }, [source]).ok, false);
});
