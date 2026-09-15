import { lengthPolicy, measureText } from "../lib/answer/length-policy.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { answer, repairInstruction } from "../lib/answer/engine.ts";
import { setup, fixture, embedding } from "./helpers.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { validateClaims } from "../lib/answer/guard.ts";
import type { AnswerProvider, ModelPayload, Evidence, Diagnostic } from "../lib/types.ts";

const original =
  "新しい企画や試作に関心が向きやすく、同じ活動に関心を持ち続けることは課題だと感じています。";

async function run(
  t: TestContext,
  select: (evidence: Evidence[], answerIndex: number) => ModelPayload,
  verifier: (candidate: ModelPayload, db: any, signal: AbortSignal) => Promise<ModelPayload> = (candidate) =>
    Promise.resolve(candidate),
  question = "苦手なことは？",
) {
  const { db, vector } = await setup({
    ...fixture,
    facts: [],
    content: "# 仕事の進め方\n\n" + original,
  });
  t.after(() => db.close());
  const calls: string[] = [];
  const repairs: (string | undefined)[] = [];
  const diagnostics: Diagnostic[] = [];
  const provider: AnswerProvider = {
    async *stream(input, signal) {
      calls.push(input.purpose ?? "answer");
      if (input.purpose !== "verify") repairs.push(input.repair);
      const payload =
        input.purpose === "verify"
          ? await verifier(input.candidate!, db, signal)
          : select(
              input.evidence,
              calls.filter((x) => x === "answer").length,
            );
      for (const segment of payload.segments) yield { type: "segment", segment };
      yield { type: "complete", payload, usage: { input: 10, output: 10 } };
    },
  };
  const events = await Array.fromAsync(
    answer(
      { mode: "meeting_text", message: question, history: [] },
      {
        repository: new KnowledgeRepository(db, fixture.ownerId),
        vector,
        embedding,
        provider,
        diagnostics: (d: Diagnostic) => diagnostics.push(d),
      },
      new AbortController().signal,
    ),
  );
  return { events, calls, repairs, diagnostics };
}

function candidate(evidence: Evidence[], text: string): ModelPayload {
  const e = evidence.find((e) => e.content.includes(original))!;
  return {
    segments: [
      {
        kind: "grounded_synthesis",
        text,
        evidenceIds: [e.id],
        claims: [
          {
            text,
            kind: "statement",
            supports: [{ evidenceId: e.id, quote: original }],
          },
        ],
      },
    ],
    answerability: "answerable",
    confidence: "high",
  };
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .join("");
}

test("paraphrase shorter original accepted EXACT text and diagnostics include usage once each", async (t) => {
  const paraphrase = "新しい企画や試作に関心が向きやすいが、同じ活動への関心を保ち続けるのは課題。";
  const { events, calls, diagnostics } = await run(t, (evidence) => candidate(evidence, paraphrase));
  assert.equal(textOf(events), paraphrase);
  assert.deepEqual(calls, ["answer", "verify"]);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics.filter((d) => d.code === "generation_complete").length, 1);
  assert.equal(diagnostics.filter((d) => d.code === "verification_complete").length, 1);
});

test("unsupported mitigation rejected then correct candidate accepted answer verify answer verify", async (t) => {
  let answerIndex = 0;
  const { events, calls } = await run(
    t,
    (evidence) => {
      const i = answerIndex++;
      if (i === 0) return candidate(evidence, "苦手を改善する具体的な対処法を実践しましょう。");
      return candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。");
    },
    async (candidatePayload) => {
      if (candidatePayload.segments[0].text.includes("改善")) {
        return { segments: [], answerability: "answerable", confidence: "low" };
      }
      return candidatePayload;
    },
  );
  assert.deepEqual(calls, ["answer", "verify", "answer", "verify"]);
  assert.equal(textOf(events), "新しい企画や試作に関心が向きやすい点が課題です。");
});

test("修復生成には判定コードではなく直す点を日本語で伝える", async (t) => {
  let answerIndex = 0;
  const { events, repairs } = await run(
    t,
    (evidence) => {
      const i = answerIndex++;
      if (i === 0) {
        const e = evidence.find((e) => e.content.includes(original))!;
        return {
          segments: [
            {
              kind: "grounded_synthesis",
              text: "引用が壊れた候補です。",
              evidenceIds: [e.id],
              claims: [
                {
                  text: "引用が壊れた候補です。",
                  kind: "statement",
                  supports: [{ evidenceId: e.id, quote: "存在しない引用文" }],
                },
              ],
            },
          ],
          answerability: "answerable",
          confidence: "high",
        };
      }
      return candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。");
    },
  );
  assert.deepEqual(repairs, [undefined, repairInstruction("quote_not_found")]);
  assert.match(repairs[1]!, /引用/);
  assert.equal(repairInstruction("未知の理由"), repairInstruction("unknown_reason"));
  assert.ok(!repairInstruction("quote_not_found").includes("quote_not_found"));
  assert.equal(textOf(events), "新しい企画や試作に関心が向きやすい点が課題です。");
});

test("malformed quote rejected before verify then repair accepted: 2 gen 1 verify", async (t) => {
  let answerIndex = 0;
  const { events, calls } = await run(
    t,
    (evidence) => {
      const i = answerIndex++;
      if (i === 0) {
        const e = evidence.find((e) => e.content.includes(original))!;
        return {
          segments: [
            {
              kind: "grounded_synthesis",
              text: "引用が壊れた候補です。",
              evidenceIds: [e.id],
              claims: [
                {
                  text: "引用が壊れた候補です。",
                  kind: "statement",
                  supports: [{ evidenceId: e.id, quote: "存在しない引用文" }],
                },
              ],
            },
          ],
          answerability: "answerable",
          confidence: "high",
        };
      }
      return candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。");
    },
  );
  assert.deepEqual(calls, ["answer", "answer", "verify"]);
  assert.equal(textOf(events), "新しい企画や試作に関心が向きやすい点が課題です。");
});

test("verifier changed text not accepted final error no text max 2 gen 2 verify", async (t) => {
  const { events, calls } = await run(
    t,
    (evidence) => candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。"),
    async (candidatePayload) => {
      const seg = candidatePayload.segments[0];
      seg.text = seg.text + "（変更）";
      return candidatePayload;
    },
  );
  assert.deepEqual(calls, ["answer", "verify", "answer", "verify"]);
  assert.equal(textOf(events), "");
  assert.ok(events.some((e) => e.type === "error"));
});

test("revoke DB revision during verifier causes no text or repair", async (t) => {
  const { events, calls } = await run(
    t,
    (evidence) => candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。"),
    async (candidatePayload, db: any) => {
      await db.prepare("UPDATE knowledge_document_revisions SET approval_status='revoked'").run();
      return candidatePayload;
    },
  );
  assert.deepEqual(calls, ["answer", "verify"]);
  assert.equal(textOf(events), "");
  assert.ok(events.some((e) => e.type === "error"));
});

test("over 220 but under 1200 first candidate repeated paragraph second short succeeds: length_exceeded max 2 gen 1 verify", async (t) => {
  const repeated = (original + "\n").repeat(6);
  let answerIndex = 0;
  const { events, calls, diagnostics } = await run(
    t,
    (evidence) => {
      const i = answerIndex++;
      if (i === 0) return candidate(evidence, repeated);
      return candidate(evidence, "新しい企画や試作に関心が向きやすい点が課題です。");
    },
  );
  assert.ok(repeated.length > 220 && repeated.length <= 1200);
  assert.deepEqual(calls, ["answer", "answer", "verify"]);
  assert.equal(textOf(events), "新しい企画や試作に関心が向きやすい点が課題です。");
  assert.ok(diagnostics.some((d) => d.code === "length_exceeded"));
});

test("pure length policy matrix", () => {
  for (const [question, max] of [["簡単な自己紹介をお願いします", 220], ["もう少し具体的に", 220],
    ["詳しくなくてよい", 220], ["詳しく教えて", 400], ["50字以内で詳しく", 50], ["1000字以内で", 400]] as const)
    assert.equal(lengthPolicy(question).max, max, question);
  assert.equal(measureText("🙂🙂"), 2);
});

test("原文が付けた単位をclaim側で省いた数値は支持として認め、別の値や単位は認めない", () => {
  const source: Evidence = { id: "ev-1", content: "週5日勤務は難しく、週3日勤務を希望しています。", documentId: "test", revisionId: "rev",
    contentHash: "hash", entities: [], title: "勤務", rank: 0, kind: "chunk" };
  const check = (text: string) => validateClaims({ text, evidenceIds: ["ev-1"], claims: [
    { text, kind: "statement", supports: [{ evidenceId: "ev-1", quote: source.content }] }] }, [source]);
  assert.equal(check("週5勤務は難しく、週3勤務を希望しています。").ok, true);
  assert.equal(check("週4勤務を希望しています。").ok, false);
  assert.equal(check("週5時間の勤務は難しいです。").ok, false);
});

test("guard validateClaims rejects reordered claim text and modified number unsupported", () => {
  const standaloneEvidence: Evidence = { id: "ev-1", content: "事実として123個ある。", documentId: "test", revisionId: "rev",
    contentHash: "hash", entities: [], title: "個数", rank: 0, kind: "chunk" };
  const claim = (text: string) => ({ text, kind: "statement" as const, supports: [{ evidenceId: "ev-1", quote: standaloneEvidence.content }] });
  const check = (text: string, texts: string[]) => validateClaims({text, evidenceIds: ["ev-1"], claims: texts.map(claim)}, [standaloneEvidence]);
  assert.equal(check("123個ある。", ["123個ある。"]).ok, true);
  assert.equal(check("123個ある。確認済み。", ["確認済み。", "123個ある。"]).ok, false);
  assert.equal(check("456個ある。", ["456個ある。"]).ok, false);
});

test("不足説明の丁寧形を校閲へ渡し、事実の単純否定や数値入りの無根拠claimは拒否する", () => {
  const source: Evidence = { id: "example", content: "企画の整理を担当しました。", documentId: "test", revisionId: "rev",
    contentHash: "hash", entities: [], title: "担当", rank: 0, kind: "chunk" };
  const check = (limitation: string) => validateClaims({ text: source.content + limitation, evidenceIds: [source.id], claims: [
    { text: source.content, kind: "statement", supports: [{ evidenceId: source.id, quote: source.content }] },
    { text: limitation, kind: "limitation", supports: [] }
  ] }, [source]);
  for (const text of ["役員経験については記録がありません。", "その経験の記録はありません。", "開始日の情報がありません。",
    "開始日の情報はありません。", "役員経験の有無については記録が確認できません。", "その点は確認できていません。"])
    assert.equal(check(text).ok, true, text);
  for (const text of ["開始可能日はまだ決まっていません。", "契約形態は未定です。", "参加するかは本人が決めることです。"])
    assert.equal(check(text).ok, true, text);
  for (const text of ["背景については面談で本人に確認してください。", "面談で本人にお聞きください。"])
    assert.equal(check(text).ok, true, text);
  for (const text of ["役員経験はありません。", "その経験はないです。", "2024年の記録はありません。",
    "コミュニティに参加している。面談で本人に確認してください。"])
    assert.equal(check(text).ok, false, text);
});

test("修復生成が棄権した場合は定型の不明回答へ戻し、処理失敗にしない", async (t) => {
  let answerIndex = 0;
  const { events, calls, diagnostics } = await run(t, (evidence) => {
    if (answerIndex++ === 0) {
      const e = evidence.find((item) => item.content.includes(original))!;
      return {
        segments: [{
          kind: "grounded_synthesis", text: "役員経験はありません。", evidenceIds: [e.id],
          claims: [{ text: "役員経験はありません。", kind: "limitation", supports: [] }],
        }],
        answerability: "answerable", confidence: "high",
      };
    }
    return { segments: [], answerability: "unknown", confidence: "low" };
  });
  assert.deepEqual(calls, ["answer", "answer"]);
  assert.equal(events.some((e) => e.type === "error"), false);
  assert.equal(textOf(events), "その点はまだ確認できていません。面談で本人に聞いてみてください。");
  assert.ok(diagnostics.some((d) => d.code === "model_abstained"));
});

test("見出しに書かれた期間も引用元として認める", () => {
  const source: Evidence = { id: "ev-1", title: "退職支援事業|2018年8月〜2024年10月",
    content: "働き方や退職に悩む人を対象とした退職支援サービスを立ち上げました。",
    documentId: "test", revisionId: "rev", contentHash: "hash", entities: [], rank: 0, kind: "chunk" };
  const check = (text: string, quote: string) => validateClaims({ text, evidenceIds: ["ev-1"],
    claims: [{ text, kind: "statement", supports: [{ evidenceId: "ev-1", quote }] }] }, [source]);
  assert.equal(check("2018年8月から退職支援事業を始めました。", "2018年8月〜2024年10月").ok, true);
  assert.equal(check("働き方や退職に悩む人を対象とした退職支援サービスを立ち上げました。", "働き方や退職に悩む人を対象とした退職支援サービスを立ち上げました。").ok, true);
  assert.equal(check("2018年8月から退職支援事業を始めました。", "2019年8月〜2020年10月").ok, false);
});
