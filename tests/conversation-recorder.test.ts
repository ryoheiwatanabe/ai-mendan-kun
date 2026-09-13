import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, writeFile, stat, open, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startConversationRecorder } from "../scripts/conversation-recorder.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 100; tries++) { if (await check()) return; await delay(10); }
  assert.fail("recording did not settle");
}
async function setup(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const temporary = await mkdtemp(join(tmpdir(), "conversation-recorder-"));
  const directory = join(temporary, "recordings");
  const upstream = createServer(handler);
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const recorder = await startConversationRecorder({ port: 0, upstreamPort: address.port, directory });
  const origin = `http://127.0.0.1:${recorder.port}`;
  t.after(async () => {
    await recorder.close(); const closed = new Promise<void>(resolve => upstream.close(() => resolve())); upstream.closeAllConnections(); await closed;
    await rm(temporary, { recursive: true, force: true });
  });
  const send = (path: string, body: string | Buffer, extra: Record<string, string> = {}) => fetch(origin + path, { method: "POST", body: typeof body === "string" ? body : Uint8Array.from(body).buffer,
    headers: { Origin: origin, "Content-Type": "application/json", ...extra } });
  const recordPath = async (session: string) => {
    const parent = join(directory, "sessions", session, "requests");
    const children = await readdir(parent); assert.equal(children.length, 1); return join(parent, children[0]);
  };
  return { temporary, directory, recorder, origin, send, recordPath };
}
const sse = (value: unknown) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
const audio = (bytes: Buffer, sequence = 0) => ({ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType: "audio/pcm", sampleRate: 24_000, channels: 1, sequence, answerId: "fictional" });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("text SSE preserves raw bytes and summary without recording headers; static GET is unrecorded", async t => {
  let received: IncomingMessage["headers"] = {};
  const response = Buffer.concat([sse({ type: "text", text: "架空の回答です。" }), sse({ type: "done" })]);
  const env = await setup(t, (req, res) => {
    received = req.headers; req.resume(); req.on("end", () => {
      if (req.method === "GET") { res.end("asset"); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Set-Cookie": "test-response-secret", "Content-Length": response.length }); res.end(response);
    });
  });
  const session = randomUUID(), input = JSON.stringify({ message: "架空の質問", history: [] });
  const parents = [join(env.directory, "sessions"), join(env.directory, "sessions", session), join(env.directory, "sessions", session, "requests")];
  await mkdir(parents[2], { recursive: true });
  for (const parent of parents) await chmod(parent, 0o755);
  const result = await env.send("/api/chat", input, { "x-test-recording-session": session, "x-test-recording-extra": "remove-me", Authorization: "test-header-secret", Cookie: "test-cookie-secret" });
  assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), response);
  const path = await env.recordPath(session), summary = await json(join(path, "summary.json")), meta = await json(join(path, "meta.json"));
  assert.equal(await readFile(join(path, "request.raw"), "utf8"), input);
  assert.deepEqual(await readFile(join(path, "response.raw")), response);
  assert.equal(summary.userText, "架空の質問"); assert.equal(summary.assistantText, "架空の回答です。"); assert.equal(summary.answerCompleted, true);
  assert.equal(meta.completed, true); assert.equal(meta.clientAbort, false); assert.ok(meta.firstByteMs >= 0); assert.ok(meta.elapsedMs >= meta.firstByteMs);
  assert.equal(received.host, `127.0.0.1:${env.recorder.port}`); assert.equal(received.origin, env.origin);
  assert.equal(received["x-test-recording-session"], undefined); assert.equal(received["x-test-recording-extra"], undefined);
  for (const file of await readdir(path)) { assert.equal((await stat(join(path, file))).mode & 0o777, 0o600); assert.doesNotMatch(await readFile(join(path, file), "utf8"), /test-(?:header|cookie|response)-secret/); }
  assert.equal((await stat(env.directory)).mode & 0o777, 0o700);
  for (const parent of [...parents, path]) assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal(await (await fetch(env.origin + "/asset.js")).text(), "asset");
  assert.equal((await readdir(join(env.directory, "sessions"))).length, 1);
});

test("transcription records input WAV and extracted text", async t => {
  const env = await setup(t, (req, res) => { req.resume(); req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "検証用の発話" })); }); });
  const session = randomUUID(), wav = Buffer.alloc(48); wav.write("RIFF"); wav.write("WAVE", 8);
  const result = await env.send("/api/voice/transcribe", wav, { "Content-Type": "audio/wav", "x-test-recording-session": session }); await result.arrayBuffer();
  const path = await env.recordPath(session);
  assert.deepEqual(await readFile(join(path, "request.raw")), wav);
  assert.equal((await json(join(path, "summary.json"))).sttText, "検証用の発話");
  assert.equal((await json(join(path, "meta.json"))).completed, true);
});

test("voice first bytes stream before completion, UTF8 split is preserved, and received PCM becomes WAV", { timeout: 5000 }, async t => {
  const release = deferred(), finished = deferred(), pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const frame = sse({ type: "text", text: "声の検証" }), split = frame.indexOf(Buffer.from("声")) + 1;
  const first = frame.subarray(0, split), rest = Buffer.concat([frame.subarray(split), sse(audio(pcm)), sse({ type: "done" })]);
  const env = await setup(t, (req, res) => { req.resume(); req.on("end", () => { res.setHeader("Content-Type", "text/event-stream"); res.write(first); void release.promise.then(() => { res.end(rest); finished.resolve(); }); }); });
  const session = randomUUID();
  const response = await env.send("/api/voice/chat", "{}", { "x-test-recording-session": session }); const reader = response.body!.getReader();
  const received = await reader.read(); assert.deepEqual(Buffer.from(received.value!), first);
  const path = await env.recordPath(session); assert.deepEqual(await readFile(join(path, "response.raw")), first);
  assert.equal((await json(join(path, "meta.json"))).completed, false);
  release.resolve(); const tail: Buffer[] = []; for (;;) { const next = await reader.read(); if (next.done) break; tail.push(Buffer.from(next.value)); }
  await finished.promise; assert.deepEqual(Buffer.concat(tail), rest);
  const summary = await json(join(path, "summary.json")); assert.equal(summary.assistantText, "声の検証"); assert.equal(summary.audioChunks, 1); assert.equal(summary.audioMeaning, "received_not_played");
  const wav = await readFile(join(path, "received-audio.wav")); assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF"); assert.equal(new DataView(Uint8Array.from(wav).buffer).getUint32(40, true), pcm.length); assert.deepEqual(wav.subarray(44), pcm);
});

test("request upload is saved and reaches upstream before upload completes", { timeout: 5000 }, async t => {
  const seen = deferred();
  const env = await setup(t, (req, res) => { req.once("data", () => seen.resolve()); req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end('{"text":"ok"}'); }); });
  const session = randomUUID(), first = Buffer.from("RIFF"), second = Buffer.from("-partial-recording");
  const client = request(env.origin + "/api/voice/transcribe", { method: "POST", headers: { Origin: env.origin, "Content-Type": "audio/wav", "x-test-recording-session": session } });
  const completed = new Promise<void>((resolve, reject) => { client.on("error", reject); client.on("response", res => { res.resume(); res.on("end", resolve); }); });
  client.write(first); await seen.promise;
  const path = await env.recordPath(session); assert.deepEqual(await readFile(join(path, "request.raw")), first);
  client.end(second); await completed;
  assert.deepEqual(await readFile(join(path, "request.raw")), Buffer.concat([first, second]));
});

test("client abort stops upstream and retains partial raw, metadata and playable received audio", { timeout: 5000 }, async t => {
  const stopped = deferred(), pcm = Buffer.alloc(24, 1);
  const env = await setup(t, (req, res) => { req.resume(); req.on("end", () => { res.setHeader("Content-Type", "text/event-stream"); res.write(sse(audio(pcm))); res.on("close", () => stopped.resolve()); }); });
  const session = randomUUID(), controller = new AbortController();
  const response = await fetch(env.origin + "/api/voice/chat", { method: "POST", body: "{}", signal: controller.signal, headers: { Origin: env.origin, "x-test-recording-session": session } });
  await response.body!.getReader().read(); controller.abort(); await stopped.promise;
  const path = await env.recordPath(session); await until(async () => (await json(join(path, "meta.json"))).clientAbort);
  const meta = await json(join(path, "meta.json")); assert.equal(meta.completed, false); assert.equal(meta.error, "client_abort");
  assert.deepEqual((await readFile(join(path, "received-audio.wav"))).subarray(44), pcm);
  assert.ok((await stat(join(path, "response.raw"))).size > 0);
});

test("storage failure before request blocks upstream and remains unhealthy", async t => {
  let calls = 0;
  const env = await setup(t, (req, res) => { calls++; req.resume(); res.end(); });
  await rm(env.directory, { recursive: true }); await writeFile(env.directory, "not a directory");
  const result = await env.send("/api/chat", "{}"); assert.equal(result.status, 503); assert.equal(calls, 0);
  assert.deepEqual(await (await fetch(env.origin + "/__test-recording/status")).json(), { enabled: true, healthy: false });
  assert.equal((await env.send("/api/chat", "{}")).status, 503); assert.equal(calls, 0);
});

test("midstream disk failure aborts forwarding and preserves partial with unhealthy latched", { timeout: 5000 }, async t => {
  const release = deferred(), marker = Buffer.from("recording-disk-failure-fixture"); let calls = 0;
  const env = await setup(t, (req, res) => { calls++; req.resume(); req.on("end", () => { res.setHeader("Content-Type", "text/event-stream"); res.write(sse({ type: "text", text: "先頭" })); void release.promise.then(() => res.end(marker)); }); });
  const handle = await open(join(env.temporary, "prototype"), "w"), prototype = Object.getPrototypeOf(handle), original = prototype.writeFile;
  await handle.close();
  t.mock.method(prototype, "writeFile", function(this: unknown, value: unknown, ...rest: unknown[]) {
    if (value instanceof Uint8Array && Buffer.compare(value, marker) === 0) return Promise.reject(new Error("simulated_storage_failure"));
    return original.call(this, value, ...rest);
  });
  const session = randomUUID(), response = await env.send("/api/chat", "{}", { "x-test-recording-session": session }), reader = response.body!.getReader();
  await reader.read(); release.resolve(); await assert.rejects(reader.read());
  const path = await env.recordPath(session); await until(async () => (await json(join(path, "meta.json"))).error === "recording_storage_failed");
  const meta = await json(join(path, "meta.json")); assert.equal(meta.completed, false); assert.equal(meta.clientAbort, false);
  assert.doesNotMatch(await readFile(join(path, "response.raw"), "utf8"), /recording-disk-failure-fixture/);
  assert.equal((await env.send("/api/chat", "{}")).status, 503); assert.equal(calls, 1);
});

test("strict Host/Origin, local read denial, unknown methods and API redirects do not bypass recording", async t => {
  let calls = 0;
  const env = await setup(t, (req, res) => { calls++; req.resume(); res.writeHead(307, { Location: "http://example.invalid/?secret=do-not-record" }); res.end(); });
  const spoofed = await new Promise<number>((resolve, reject) => {
    const client = request(env.origin + "/api/chat", { method: "POST", headers: { Host: "localhost:8788", Origin: env.origin } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
    client.on("error", reject); client.end("{}");
  });
  assert.equal(spoofed, 421);
  assert.equal((await env.send("/api/chat", "{}", { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await fetch(env.origin + "/__test-recording/events")).status, 405);
  assert.equal((await fetch(env.origin + "/.local/conversation-recordings/events.ndjson")).status, 404);
  assert.equal((await env.send("/__test-recording/unknown", "{}")).status, 404);
  assert.equal((await env.send("/unknown", "{}")).status, 405); assert.equal(calls, 0);
  const session = randomUUID(); const result = await env.send("/api/chat", "{}", { "x-test-recording-session": session });
  assert.equal(result.status, 502); assert.equal(result.headers.get("location"), null); assert.equal(calls, 1);
  const path = await env.recordPath(session); await until(async () => (await json(join(path, "meta.json"))).error === "upstream_redirect_blocked");
  for (const file of await readdir(path)) assert.doesNotMatch(await readFile(join(path, file), "utf8"), /do-not-record/);
});

test("events append privately; microphone handles end-first, out-of-order, duplicates, conflict and size limits", async t => {
  let calls = 0; const env = await setup(t, (_req, res) => { calls++; res.end(); });
  const session = randomUUID(), capture = randomUUID();
  const event = { sessionId: session, type: "voice:played", at: new Date().toISOString(), data: { sequence: 0 } };
  assert.equal((await env.send("/__test-recording/events", JSON.stringify(event))).status, 200);
  const log = join(env.directory, "sessions", session, "events.ndjson"); assert.deepEqual(JSON.parse(await readFile(log, "utf8")), event);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  assert.equal((await env.send("/__test-recording/events", JSON.stringify({ ...event, data: { value: "data:audio/webm;base64,AAAA" } }))).status, 400);
  assert.equal((await env.send("/__test-recording/events", "a".repeat(65_537))).status, 413);
  assert.equal((await env.send("/__test-recording/microphone-end", JSON.stringify({ sessionId: session, captureId: capture, count: 3, mimeType: "audio/webm;codecs=opus" }))).status, 200);
  const sendPart = (sequence: number, value: string | Buffer) => env.send(`/__test-recording/microphone?session=${session}&capture=${capture}&sequence=${sequence}`, Buffer.from(value), { "Content-Type": "audio/webm;codecs=opus" });
  const statuses = await Promise.all([sendPart(2, "third"), sendPart(0, "first"), sendPart(1, "second")]); assert.deepEqual(statuses.map(result => result.status), [200, 200, 200]);
  const path = join(env.directory, "sessions", session, "microphone", capture);
  for (const parent of [join(env.directory, "sessions"), join(env.directory, "sessions", session), join(env.directory, "sessions", session, "microphone"), path])
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(path, "microphone.webm"), "utf8"), "firstsecondthird");
  assert.equal((await json(join(path, "manifest.json"))).complete, true);
  assert.equal((await sendPart(0, "first")).status, 200); assert.equal((await sendPart(0, "changed")).status, 409);
  assert.equal(await readFile(join(path, "0.part"), "utf8"), "first");
  assert.equal((await sendPart(0, Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413); assert.equal(calls, 0);
});

test("stop intent retains playable partial microphone; late parts update it and final end completes it", async t => {
  const env = await setup(t, (_req, res) => res.end());
  const sessionId = randomUUID(), captureId = randomUUID(), path = join(env.directory, "sessions", sessionId, "microphone", captureId);
  const part = (sequence: number, bytes: string) => env.send(`/__test-recording/microphone?session=${sessionId}&capture=${captureId}&sequence=${sequence}`, Buffer.from(bytes), { "Content-Type": "audio/mp4" });
  assert.equal((await part(1, "second")).status, 200);
  assert.equal((await env.send("/__test-recording/events", JSON.stringify({ sessionId, type: "microphone-stop-requested", at: new Date().toISOString(), data: { captureId, count: 2, mimeType: "audio/mp4" } }))).status, 200);
  assert.equal((await json(join(path, "partial-manifest.json"))).contiguousParts, 0);
  assert.equal((await part(0, "first")).status, 200);
  assert.equal(await readFile(join(path, "microphone.partial.mp4"), "utf8"), "firstsecond");
  assert.equal((await json(join(path, "partial-manifest.json"))).complete, false);
  assert.equal((await part(2, "last")).status, 200);
  assert.equal(await readFile(join(path, "microphone.partial.mp4"), "utf8"), "firstsecondlast");
  assert.equal((await env.send("/__test-recording/microphone-end", JSON.stringify({ sessionId, captureId, count: 3, mimeType: "audio/mp4" }))).status, 200);
  assert.equal(await readFile(join(path, "microphone.mp4"), "utf8"), "firstsecondlast");
  assert.equal((await json(join(path, "manifest.json"))).complete, true);
});
