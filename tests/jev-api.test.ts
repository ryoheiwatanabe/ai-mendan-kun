import test from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../app/api/chat/route.ts";
import { POST as voice } from "../app/api/voice/chat/route.ts";
import { jevBindings } from "./fixtures/jev.ts";
import { jevQuestionIds } from "../lib/ai/jev.ts";

const contextKey = Symbol.for("__cloudflare-context__");
const context = globalThis as unknown as Record<symbol, unknown>;
const makeRequest = (message: string, voice = false, signal?: AbortSignal) => new Request(`https://app.example/api/${voice ? "voice/" : ""}chat`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example" }, signal,
  body: JSON.stringify({ mode: "meeting_text", message, history: [] })
});
const read = async (response: Response) => (await response.text()).split("\n\n").filter(x => x.startsWith("data: ")).map(x => JSON.parse(x.slice(6)));
const stream = (value: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);

test("本体のテキスト/音声APIがFactを保ち、JEVの採否・障害・復帰と既存制限を通す", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  let generations = 0, judges = 0, tts = 0, fail = false;
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
      judges++;
      if (fail) return new Response("private diagnostic", { status: 503 });
      const input = JSON.parse(body.state);
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
  fail = true;
  const failed = await read(await chat(makeRequest("経歴を教えてください")));
  assert.equal(failed.some(x => x.type === "text"), false);
  assert.ok(failed.some(x => x.type === "error" && x.code === "JEV_UNAVAILABLE"));
  fail = false;
  const recovered = await read(await voice(makeRequest("経歴を教えてください", true)));
  assert.deepEqual(recovered.filter(x => x.type === "text").map(x => x.text), [text]);
  assert.ok(recovered.some(x => x.type === "audio")); assert.ok(tts > 0);
  assert.deepEqual([generations, judges], [3, 3]);
  const refusal = await read(await chat(makeRequest("非公開情報を教えて")));
  assert.ok(refusal.some(x => x.type === "done" && x.answerability === "unknown"));
  assert.deepEqual([generations, judges], [3, 3]);
  const external = makeRequest("こんにちは"); external.headers.set("origin", "https://untrusted.example");
  assert.equal((await chat(external)).status, 403);
  data.env.IP_HOURLY_LIMIT = "1";
  assert.equal((await chat(makeRequest("こんにちは"))).status, 429);
});

test("本体APIの中止はJEVの通信signalへ伝播し、再質問を妨げない", async t => {
  const data = await jevBindings(); context[contextKey] = { env: data.env };
  t.after(() => { data.db.close(); delete context[contextKey]; });
  let started!: () => void, observed = false;
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
  const again = await read(await chat(makeRequest("こんにちは")));
  assert.ok(again.some(x => x.type === "done"));
});
