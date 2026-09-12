import test from "node:test";
import assert from "node:assert/strict";
import { readSse } from "../lib/ai/sse.ts";

test("SSEの読み取り待ちは中断でき、通信のcancel完了を待たない", { timeout: 1000 }, async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } });
  const controller = new AbortController(), iterator = readSse(stream, controller.signal);
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test("SSEの途中で購読を終えた場合も未完了のcancelが後処理を止めない", { timeout: 1000 }, async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\ndata: late\n\n")); },
    cancel() { cancelled++; return new Promise(() => {}); }
  });
  const iterator = readSse(stream);
  assert.equal((await iterator.next()).value, "first");
  await iterator.return(undefined);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});
