// ブラウザと同じHTTP経路を通す。モデル送信だけを模擬し、外部APIを呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AnswerProvider, ModelPayload } from "../../../lib/types.ts";

const temp = mkdtempSync(join(tmpdir(), "manual-lab-"));
process.env.LAB_API_KEY = "local-test-secret";
process.env.LAB_MANUAL_RECORDS = join(temp, "manual.jsonl");
const { server } = await import("../src/server.mts");
const { createManualPlan, executeManualPlan, manualEndpoint } = await import("../src/manual.mts");
const config = { baseUrl: manualEndpoint, apiKey: "local-test-secret", model: "glm-5.3-flash",
  session: "test", temperature: 0, maxTokens: 64, timeoutMs: 5000 };
const originalFetch = globalThis.fetch;
let externalCalls = 0;
let providerFailure = false;
const sent: Record<string, unknown>[] = [];
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
  assert.equal(url, manualEndpoint + "/chat/completions");
  externalCalls++;
  sent.push(JSON.parse(String(init?.body)));
  assert.equal(init?.redirect, "manual");
  if (providerFailure) return new Response("unavailable", { status: 503 });
  const payload = JSON.stringify({ answer: "架空の検証回答です。", sourceIds: [], limitations: "" });
  const event = { choices: [{ delta: { content: payload } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  return new Response("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}) as typeof fetch;

test("手動画面は確認済み一問だけをB/Cへ送り、エラーも回数へ記録する", async t => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    await t.test("表示・計画確認は0 calls、キーを返さない", async () => {
      assert.equal((await fetch(base + "/manual")).status, 200);
      const state = await (await fetch(base + "/api/manual/state")).json();
      assert.equal(state.keyConfigured, true);
      assert.ok(!JSON.stringify(state).includes(config.apiKey));
      assert.ok(!JSON.stringify(state.documents).includes("12パーセント"));
      assert.deepEqual(state.modes.map((mode: { id: string }) => mode.id), ["B", "C"]);
      await fetch(base + "/api/manual/records");
      await post("/api/manual/plan", { mode: "B", question: "仕事で苦労したことは？" });
      assert.equal(externalCalls, 0);
    });
    await t.test("B成功・質問の差し替えと二重実行を防ぐ", async () => {
      const question = "独立してからは何を担当しましたか？";
      const { plan } = await (await post("/api/manual/plan", { mode: "B", question })).json();
      const { record } = await (await post("/api/manual/run", { planId: plan.id, fictionalOnly: true, question: "差し替え" })).json();
      assert.equal(record.answer, "架空の検証回答です。");
      assert.equal(record.question, question); assert.equal(record.execution.apiCalls, 1);
      assert.equal(record.manifest.entrypoint, "runB");
      assert.equal((await post("/api/manual/run", { planId: plan.id, fictionalOnly: true })).status, 400);
      assert.equal(externalCalls, 1);
      assert.ok(JSON.stringify(sent[0]).includes(question));
      assert.ok(!JSON.stringify(sent[0]).includes("差し替え"));
    });
    await t.test("Cは現行生成へ接続し、HTTP失敗でも1 callを残す", async () => {
      providerFailure = true;
      const { plan } = await (await post("/api/manual/plan", { mode: "C", question: "独立してからは何を担当しましたか？" })).json();
      const { record } = await (await post("/api/manual/run", { planId: plan.id, fictionalOnly: true })).json();
      assert.equal(record.manifest.entrypoint, "retrieveForLab+runC");
      assert.equal(record.execution.apiCalls, 1);
      assert.equal(record.execution.status, "error");
      assert.equal(externalCalls, 2);
      const records = await (await fetch(base + "/api/manual/records")).json();
      assert.equal(records.records.length, 2);
      assert.ok(!JSON.stringify(records).includes(config.apiKey));
    });
    await t.test("外部Origin・確認なし・不正な送信先を送信前に拒否", async () => {
      assert.equal((await post("/api/manual/plan", {}, { Origin: "https://other.example" })).status, 403);
      assert.equal((await post("/api/manual/run", { planId: "none" })).status, 400);
      assert.throws(() => createManualPlan({ mode: "C", question: "test" }, { ...config, baseUrl: "https://other.example" }), /endpoint_mismatch/);
      assert.equal(externalCalls, 2);
    });
    await t.test("中止済み操作はモデルを呼ばない", async () => {
      const plan = createManualPlan({ mode: "B", question: "test" }, config);
      await assert.rejects(executeManualPlan(plan, config, AbortSignal.abort()), /abort/i);
      assert.equal(externalCalls, 2);
    });
    await t.test("Cの生成・校閲を通った回答を画面用記録へ返す", async () => {
      const purposes: string[] = [];
      const provider: AnswerProvider = { async *stream(input) {
        purposes.push(input.purpose ?? "answer");
        const source = input.evidence.find(item => item.title.includes("調べる") && !item.title.includes("具体例"))!;
        assert.ok(source);
        const text = "調べる習慣は、家に辞書があったことから始まったと伝えています。";
        const payload: ModelPayload = { answerability: "answerable", confidence: "high", segments: [{ kind: "grounded_synthesis",
          text, evidenceIds: [source.id], claims: [{ text, kind: "statement",
            supports: [{ evidenceId: source.id, quote: "調べる習慣は、家に辞書があったことから始まったと本人は述べています。" }] }] }] };
        if (input.purpose !== "verify") yield { type: "segment", segment: payload.segments[0] };
        yield { type: "complete", payload, ...(input.purpose === "verify" ? { verification: { accepted: true, reason: "supported" } } : {}) };
      } };
      const plan = createManualPlan({ mode: "C", caseId: "M03", question: "その強みはどう身につけましたか？" }, config);
      const record = await executeManualPlan(plan, config, new AbortController().signal, { provider });
      assert.deepEqual(purposes, ["answer", "verify"]);
      assert.equal(record.execution.apiCalls, 2);
      assert.equal(record.execution.status, "ok");
      assert.ok(record.answer.includes("辞書"));
      assert.equal(externalCalls, 2);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    rmSync(temp, { recursive: true, force: true });
  }
});
