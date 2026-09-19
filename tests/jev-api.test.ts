import test from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../app/api/chat/route.ts";
import { POST as voice } from "../app/api/voice/chat/route.ts";
import { jevBindings } from "./fixtures/jev.ts";
import { jevQuestionIds } from "../lib/ai/jev.ts";
import { jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopePrimaryEvidenceId } from "../lib/ai/jev-scope.ts";

const contextKey = Symbol.for("__cloudflare-context__");
const context = globalThis as unknown as Record<symbol, unknown>;
const makeRequest = (message: string, voice = false, signal?: AbortSignal) => new Request(`https://app.example/api/${voice ? "voice/" : ""}chat`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example" }, signal,
  body: JSON.stringify({ mode: "meeting_text", message, history: [] })
});
const read = async (response: Response) => (await response.text()).split("\n\n").filter(x => x.startsWith("data: ")).map(x => JSON.parse(x.slice(6)));
const stream = (value: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
// 生成前の選別はChoice/Score/Noulが混ざる。質問の型どおりに答えを返す。
const scopeReply = (questions: Record<string, any>, candidateIds: string[]) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
  if (question.type === "choice") {
    const value = id === jevScopeAnswerScopeId ? "answerable" : id === jevScopeEvidenceRoleId ? "direct"
      : id === jevScopePrimaryEvidenceId ? candidateIds[0] ?? "none_of_the_above" : Object.keys(question.criteria)[0];
    return [id, { type: "choice", choice: value, confidence: .9 }];
  }
  if (question.type === "score") return [id, { type: "score", score: 3, confidence: .9 }];
  return [id, { type: "noul", noul: .98 }];
}));

test("本体のテキスト/音声APIがFactを保ち、JEVの採否・障害・復帰と既存制限を通す", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  let generations = 0, judges = 0, scopeJudges = 0, tts = 0, fail = false;
  const text = "2016〜2019年はナギサ社で営業、2020〜2023年はコハク社で業務改善を担当しました。2024年に独立し、業務整理を支援しています。";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      generations++;
      assert.equal(body.response_format.json_schema.name, "compact_answer");
      const input = JSON.parse(body.messages.at(-1).content);
      assert.ok(input.evidence.some((e: any) => e.id.startsWith("fact:")), "Factを生成まで保持する");
      return stream({ text, answerability: "answerable", evidenceIds: input.evidence.map((e: any) => e.id) });
    }
    if (url.includes("api.typesafe.ai")) {
      // 生成前の選別（JEV①）と回答の点検（JEV②）は別の質問セットで来る。
      if (jevScopeAnswerScopeId in (body.questions as Record<string, unknown>)) {
        scopeJudges++;
        if (fail) return new Response("private diagnostic", { status: 503 });
        // stateは役割ごとの名前付きJSONで届く。
        const selection = body.state as { candidate_evidence: { id: string }[]; task: string; answer_policy: string; subject: unknown };
        assert.equal(typeof body.state, "object");
        assert.equal("candidate" in selection, false, "選別には候補本文を送らない");
        assert.ok(selection.task.includes("判定") && typeof selection.answer_policy === "string" && !!selection.subject);
        assert.ok(selection.candidate_evidence.some((e: any) => e.id.startsWith("fact:")), "選別にも同じFactが届く");
        return Response.json({ answers: scopeReply(body.questions, selection.candidate_evidence.map(item => item.id)) });
      }
      judges++;
      if (fail) return new Response("private diagnostic", { status: 503 });
      const input = body.state as { candidate: string; evidence: { id: string }[]; answer_scope?: string };
      assert.equal(typeof body.state, "object", "点検のstateも構造化JSONで送る");
      assert.ok(typeof input.answer_scope === "string" && input.answer_scope.length > 0, "選別が決めた回答可能範囲を点検でも渡す");
      assert.equal(input.candidate, text);
      assert.ok(input.evidence.some((e: any) => e.id.startsWith("fact:")), "同じFactがJEVに届く");
      return Response.json({ answers: Object.fromEntries(jevQuestionIds.map(axis => [axis, { type: "noul", noul: .98 }])) });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      tts++;
      return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/l16", sample_rate: 24000, channels: 1, data: Buffer.alloc(12000).toString("base64") }] }] });
    }
    throw new Error("unexpected_destination");
  });
  const first = await read(await chat(makeRequest("経歴を教えてください")));
  assert.deepEqual(first.filter(x => x.type === "text").map(x => x.text), [text]);
  assert.deepEqual([generations, judges], [1, 1]);
  assert.equal(scopeJudges, 1, "生成前の選別は1問1回");
  const selected = first.find(x => x.type === "trace")?.trace ?? [];
  assert.ok(selected.some((entry: any) => entry.code === "scope_complete"), "選別の完了を記録する");
  fail = true;
  const failed = await read(await chat(makeRequest("経歴を教えてください")));
  assert.equal(failed.some(x => x.type === "text"), false);
  assert.ok(failed.some(x => x.type === "error" && x.code === "JEV_UNAVAILABLE"));
  // 失敗しても、止まった段階を画面とローカル記録で確認できるようにする。
  const failureTrace = failed.find(x => x.type === "trace") as { trace: Array<{ code: string; reason?: string }> } | undefined;
  assert.ok(failureTrace, "失敗した応答にも段階の記録を返す");
  assert.ok(failureTrace.trace.some(entry => entry.code === "jev_error"), "止まった段階を含む");
  fail = false;
  const recovered = await read(await voice(makeRequest("経歴を教えてください", true)));
  assert.deepEqual(recovered.filter(x => x.type === "text").map(x => x.text), [text]);
  assert.ok(recovered.some(x => x.type === "audio")); assert.ok(tts > 0);
  // 点検の一時的な失敗は1回だけ試し直すため、失敗した質問では点検が2回呼ばれる。
  assert.deepEqual([generations, judges], [3, 4]);
  const refusal = await read(await chat(makeRequest("非公開情報を教えて")));
  assert.ok(refusal.some(x => x.type === "done" && x.answerability === "unknown"));
  assert.deepEqual([generations, judges], [3, 4]);
  const external = makeRequest("こんにちは"); external.headers.set("origin", "https://untrusted.example");
  assert.equal((await chat(external)).status, 403);
  data.env.IP_HOURLY_LIMIT = "1";
  assert.equal((await chat(makeRequest("こんにちは"))).status, 429);
});

test("本体APIの中止はJEVの通信signalへ伝播し、再質問を妨げない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  let started!: () => void, observed = false;
  // 実行記録に、中止と「止まった段階」が残ることを確かめる。
  const logged: string[] = [];
  t.mock.method(console, "info", (line: string) => { logged.push(line); });
  const waitForJudge = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes("opencode.ai")) {
      const input = JSON.parse(body.messages.at(-1).content);
      return stream({ text: "課題を小さく分けることです。", answerability: "answerable", evidenceIds: input.evidence.map((e: any) => e.id) });
    }
    started();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => { observed = true; reject(init.signal!.reason); }, { once: true }));
  });
  const controller = new AbortController();
  const response = await chat(makeRequest("強みは？", false, controller.signal));
  const events = read(response);
  await waitForJudge; controller.abort();
  assert.equal((await events).some(x => x.type === "text"), false);
  assert.equal(observed, true);
  assert.ok(logged.some(line => line.includes('"answer_aborted"')), "中止として記録する");
  assert.ok(logged.some(line => line.includes('"stream_failure"') && line.includes('"iterator_aborted"')), "止まった段階を記録する");
  const again = await read(await chat(makeRequest("こんにちは")));
  assert.ok(again.some(x => x.type === "done"));
});
