import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, chmod, open, readFile, readdir, rename, writeFile, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";

const host = "127.0.0.1";
const apis = new Set(["/api/chat", "/api/voice/chat", "/api/voice/transcribe"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxParts = 86_400;
class Rejected extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
class StorageFailure extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const missing = (error: unknown) => object(error) && error.code === "ENOENT";
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > limit) { req.resume(); throw new Rejected(413, "recording_body_too_large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await body(req, 65_536);
  try { const value: unknown = JSON.parse(utf8(bytes)); if (object(value)) return value; } catch {}
  throw new Rejected(400, "invalid_recording_json");
}
function mime(value: unknown): "audio/webm" | "audio/mp4" {
  if (typeof value !== "string" || !/^audio\/(?:webm|mp4)(?:\s*;\s*codecs\s*=\s*(?:"[a-z0-9., -]+"|[a-z0-9.,-]+))?$/i.test(value))
    throw new Rejected(415, "invalid_recording_mime");
  return value.split(";")[0].toLowerCase() as "audio/webm" | "audio/mp4";
}
async function writeTo(stream: Writable, bytes: Buffer) {
  if (stream.destroyed) throw new Error("closed_stream");
  if (stream.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { stream.off("drain", drained); stream.off("close", closed); stream.off("error", failed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("closed_stream")); };
    const failed = () => { cleanup(); reject(new Error("stream_error")); };
    stream.once("drain", drained); stream.once("close", closed); stream.once("error", failed);
  });
}
function headers(source: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const blocked = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  for (const field of (source.connection || "").split(",")) blocked.add(field.trim().toLowerCase());
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key) && !key.startsWith("x-test-recording-")));
}
function wavHeader(size: number): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF"); bytes.writeUInt32LE(size + 36, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
type Summary = { userText: string; sttText: string; assistantText: string; answerCompleted: boolean; audioChunks: number; audioBytes: number; audioMeaning: "received_not_played"; errors: string[] };
const newSummary = (): Summary => ({ userText: "", sttText: "", assistantText: "", answerCompleted: false, audioChunks: 0, audioBytes: 0, audioMeaning: "received_not_played", errors: [] });

// 新しい正規化の原文比較通知は会話中のメモリだけで扱う。既存の記録範囲へ追加しない。
class RecordedSse {
  private prefix: number[] = [];
  private mode: "unknown" | "keep" | "drop" = "unknown";
  private tail = "";
  push(bytes: Buffer, finish = false): Buffer {
    const output: number[] = [];
    for (const byte of bytes) {
      this.tail = (this.tail + String.fromCharCode(byte)).slice(-4);
      if (this.mode === "keep") output.push(byte);
      else if (this.mode === "unknown") {
        this.prefix.push(byte);
        const head = Buffer.from(this.prefix).toString("utf8");
        // 通常イベントはtypeを確認した時点で元のbytesを流し、途中のUTF-8も保持する。
        const type = /^data:\s*\{\s*"type"\s*:\s*"([^"]+)"/u.exec(head);
        if (type) this.mode = type[1] === "input-normalized" ? "drop" : "keep";
        else if (!"data:".startsWith(head.trimStart()) && !head.trimStart().startsWith("data:")) this.mode = "keep";
        else if (this.prefix.length > 512) this.mode = "drop";
        if (this.mode === "keep") output.push(...this.prefix);
        if (this.mode !== "unknown") this.prefix = [];
      }
      if (/\r?\n\r?\n$/u.test(this.tail)) {
        if (this.mode === "unknown") output.push(...this.prefix);
        this.prefix = []; this.tail = ""; this.mode = "unknown";
      }
    }
    if (finish) {
      const partial = Buffer.from(this.prefix).toString("utf8");
      if (!/input-normalized|"(?:raw|rawTranscript|alternatives)"/u.test(partial)) output.push(...this.prefix);
      this.prefix = [];
    }
    return Buffer.from(output);
  }
}

class ResponseSummary {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private overflow = false;
  private sse: boolean; private transcription: boolean; private summary: Summary; private audio: (bytes: Buffer) => Promise<void>;
  constructor(sse: boolean, transcription: boolean, summary: Summary, audio: (bytes: Buffer) => Promise<void>) {
    this.sse = sse; this.transcription = transcription; this.summary = summary; this.audio = audio;
  }
  async push(bytes: Buffer) {
    if (this.overflow) return;
    this.pending += this.decoder.write(bytes);
    if (this.sse) {
      for (;;) {
        const match = /\r?\n\r?\n/.exec(this.pending);
        if (!match) break;
        const frame = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length);
        if (frame.length > 1_048_576) { this.error("summary_frame_too_large"); continue; }
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) await this.event(data);
      }
    }
    if (this.pending.length > 1_048_576) { this.pending = ""; this.overflow = true; this.error("summary_too_large"); }
  }
  error(code: string) { if (this.summary.errors.length < 32) this.summary.errors.push(code); }
  private async event(text: string) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { this.error("invalid_response_json"); return; }
    if (!object(value)) return;
    if (this.transcription && typeof value.text === "string") this.summary.sttText = value.text.slice(0, 100_000);
    else if (value.type === "text" && typeof value.text === "string") this.summary.assistantText = (this.summary.assistantText + value.text).slice(0, 100_000);
    if (value.type === "done") this.summary.answerCompleted = true;
    if (value.type === "error" || object(value.error)) this.error(typeof value.code === "string" && /^[\w.-]{1,80}$/.test(value.code) ? value.code : "upstream_error");
    if (value.type !== "audio") return;
    if (value.mimeType !== "audio/pcm" || value.sampleRate !== 24_000 || value.channels !== 1 || typeof value.data !== "string"
      || !value.data.length || value.data.length > 1_000_000 || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) { this.error("invalid_audio"); return; }
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.length % 2 || bytes.toString("base64") !== value.data || this.summary.audioBytes + bytes.length > 0xffff_ffdb) { this.error("invalid_audio"); return; }
    await this.audio(bytes);
    this.summary.audioBytes += bytes.length; this.summary.audioChunks++;
  }
  async finish() {
    this.pending += this.decoder.end();
    if (this.overflow) return;
    if (!this.sse && this.pending.trim()) await this.event(this.pending);
    else if (this.sse && this.pending.trim()) this.error("partial_sse_frame");
  }
}

export async function startConversationRecorder(options: { port?: number; upstreamPort?: number; directory?: string } = {}) {
  const port = options.port ?? 8788, upstreamPort = options.upstreamPort ?? 8789;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 || port === upstreamPort)
    throw new Error("invalid_recorder_port");
  const directory = resolve(options.directory ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".local", "conversation-recordings", randomUUID()));
  let healthy = true, boundPort = 0;
  const jobs = new Set<Promise<void>>();
  const locks = new Map<string, Promise<unknown>>();
  const disk = async <T>(operation: Promise<T>): Promise<T> => {
    try { return await operation; } catch { healthy = false; throw new StorageFailure("recording_storage_failed"); }
  };
  const directoryAt = async (path: string) => {
    await disk(mkdir(path, { recursive: true, mode: 0o700 }));
    let current = directory; await disk(chmod(current, 0o700));
    for (const part of relative(directory, path).split(sep).filter(Boolean)) {
      current = join(current, part); await disk(chmod(current, 0o700));
    }
  };
  const save = async (path: string, value: unknown) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await disk(writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }));
    await disk(rename(temporary, path));
  };
  const existing = async (path: string): Promise<Buffer | null> => {
    try { return await readFile(path); } catch (error) { if (missing(error)) return null; healthy = false; throw new StorageFailure("recording_storage_failed"); }
  };
  await directoryAt(directory);
  const probe = await disk(open(join(directory, ".recorder-ready"), "a", 0o600)); await disk(probe.close());
  const serialize = async (key: string, operation: () => Promise<void>) => {
    const task = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, task);
    try { await task; } finally { if (locks.get(key) === task) locks.delete(key); }
  };
  const assemble = async (path: string) => {
    const data = await existing(join(path, "manifest.json")), stopped = await existing(join(path, "stop-requested.json"));
    if (!data && !stopped) return;
    const manifest = data ? JSON.parse(utf8(data)) as { count: number; mimeType: string; complete?: boolean } : null;
    const stop = stopped ? JSON.parse(utf8(stopped)) as { count: number; mimeType: string } : null;
    if (manifest?.complete) return;
    const files = new Set(await disk(readdir(path)));
    let contiguous = 0; while (contiguous < maxParts && files.has(`${contiguous}.part`)) contiguous++;
    const complete = !!manifest && contiguous === manifest.count;
    if (!complete && !stop) return;
    const count = complete ? manifest!.count : contiguous, format = manifest?.mimeType ?? stop!.mimeType;
    const output = join(path, `microphone${complete ? "" : ".partial"}.${format === "audio/mp4" ? "mp4" : "webm"}`);
    const temporary = `${output}.tmp`, file = await disk(open(temporary, "w", 0o600)); let bytes = 0;
    try {
      for (let index = 0; index < count; index++) {
        for await (const chunk of createReadStream(join(path, `${index}.part`))) { await disk(file.writeFile(chunk)); bytes += chunk.length; }
      }
    } catch (error) { healthy = false; throw error; } finally { await disk(file.close()); }
    await disk(rename(temporary, output));
    if (complete) await save(join(path, "manifest.json"), { ...manifest, complete: true, bytes });
    else await save(join(path, "partial-manifest.json"), { complete: false, reason: "stop_requested_without_all_final_parts", contiguousParts: count, reportedParts: stop!.count, bytes, mimeType: format });
  };
  const local = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method === "GET" && url.pathname === "/__test-recording/status") { reply(res, 200, { enabled: true, healthy }); return; }
    if (req.method !== "POST") throw new Rejected(405, "recording_read_forbidden");
    if (!healthy) throw new Rejected(503, "recording_storage_failed");
    if (url.pathname === "/__test-recording/events") {
      const value = await jsonBody(req);
      if (!id(value.sessionId) || typeof value.type !== "string" || !/^[\w.:-]{1,80}$/.test(value.type)
        || typeof value.at !== "string" || value.at.length > 40 || !Number.isFinite(Date.parse(value.at)) || !object(value.data)) throw new Rejected(400, "invalid_recording_event");
      // 通信認証情報やdata URLをtelemetryへ誤って載せない。
      if (/"(?:headers?|authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token)"\s*:|"data:[^" ]/i.test(JSON.stringify(value.data))) throw new Rejected(400, "unsafe_recording_event");
      const path = join(directory, "sessions", value.sessionId.toLowerCase()); await directoryAt(path);
      const file = await disk(open(join(path, "events.ndjson"), "a", 0o600));
      try { await disk(file.writeFile(JSON.stringify(value) + "\n")); } finally { await disk(file.close()); }
      if (value.type === "microphone-stop-requested") {
        const { captureId, count, mimeType } = value.data;
        if (!id(captureId) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > maxParts) throw new Rejected(400, "invalid_recording_stop");
        const format = mime(mimeType), capturePath = join(path, "microphone", captureId.toLowerCase());
        await serialize(capturePath, async () => {
          await directoryAt(capturePath);
          const previous = await existing(join(capturePath, "capture.json"));
          if (previous && JSON.parse(utf8(previous)).mimeType !== format) throw new Rejected(409, "recording_mime_conflict");
          if (!previous) await save(join(capturePath, "capture.json"), { mimeType: format });
          await save(join(capturePath, "stop-requested.json"), { at: value.at, count, mimeType: format });
          await assemble(capturePath);
        });
      }
      reply(res, 200, { saved: true }); return;
    }
    if (url.pathname !== "/__test-recording/microphone" && url.pathname !== "/__test-recording/microphone-end") throw new Rejected(404, "recording_route_not_found");
    const ending = url.pathname.endsWith("-end"), value = ending ? await jsonBody(req) : null;
    const session = value?.sessionId ?? url.searchParams.get("session"), capture = value?.captureId ?? url.searchParams.get("capture");
    if (!id(session) || !id(capture)) throw new Rejected(400, "invalid_recording_id");
    const format = mime(ending ? value!.mimeType : req.headers["content-type"]);
    const sequence = url.searchParams.get("sequence");
    const number = ending ? value!.count : typeof sequence === "string" && /^(?:0|[1-9]\d*)$/.test(sequence) ? Number(sequence) : NaN;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > maxParts || !ending && number === maxParts) throw new Rejected(400, "invalid_recording_count");
    const bytes = ending ? null : await body(req, 2 * 1024 * 1024);
    const path = join(directory, "sessions", session.toLowerCase(), "microphone", capture.toLowerCase());
    await serialize(path, async () => {
      await directoryAt(path);
      const info = await existing(join(path, "capture.json"));
      if (info && JSON.parse(utf8(info)).mimeType !== format) throw new Rejected(409, "recording_mime_conflict");
      if (!info) await save(join(path, "capture.json"), { mimeType: format });
      const manifest = await existing(join(path, "manifest.json"));
      if (ending) {
        if (manifest && JSON.parse(utf8(manifest)).count !== number) throw new Rejected(409, "recording_count_conflict");
        const files = await disk(readdir(path));
        if (files.some(file => /^\d+\.part$/.test(file) && Number(file.split(".")[0]) >= number)) throw new Rejected(409, "recording_count_conflict");
        if (!manifest) await save(join(path, "manifest.json"), { count: number, mimeType: format, complete: false });
      } else {
        if (manifest && number >= JSON.parse(utf8(manifest)).count) throw new Rejected(409, "recording_count_conflict");
        const part = join(path, `${number}.part`), previous = await existing(part);
        if (previous && Buffer.compare(previous, bytes!) !== 0) throw new Rejected(409, "recording_part_conflict");
        if (!previous) await disk(writeFile(part, bytes!, { mode: 0o600, flag: "wx" }));
      }
      await assemble(path);
    });
    reply(res, 200, { saved: true });
  };

  const proxy = async (req: IncomingMessage, res: ServerResponse, url: URL, recording: boolean) => {
    const started = performance.now(), summary = newSummary();
    const meta = { path: url.pathname, startedAt: new Date().toISOString(), status: null as number | null, firstByteMs: null as number | null,
      elapsedMs: 0, clientAbort: false, completed: false, error: null as string | null };
    let path = "", requestFile: FileHandle | undefined, responseFile: FileHandle | undefined, audioFile: FileHandle | undefined;
    const files: FileHandle[] = [];
    const controller = new AbortController();
    const clientAbort = () => { if (!res.writableFinished && !controller.signal.aborted) { meta.clientAbort = true; controller.abort(); } };
    req.once("aborted", clientAbort); res.once("close", clientAbort);
    let parser: ResponseSummary | undefined, recordedSse: RecordedSse | undefined, requestJson = "", requestJsonTooLarge = false;
    const requestDecoder = new StringDecoder("utf8");
    try {
      if (recording) {
        const session = req.headers["x-test-recording-session"];
        if (session !== undefined && !id(session)) throw new Rejected(400, "invalid_recording_session");
        path = join(directory, "sessions", typeof session === "string" ? session.toLowerCase() : randomUUID(), "requests", randomUUID());
        await directoryAt(path);
        requestFile = await disk(open(join(path, "request.raw"), "wx", 0o600)); files.push(requestFile);
        responseFile = await disk(open(join(path, "response.raw"), "wx", 0o600)); files.push(responseFile);
        if (url.pathname === "/api/voice/chat") {
          audioFile = await disk(open(join(path, "received-audio.wav"), "wx", 0o600)); files.push(audioFile);
          await disk(audioFile.writeFile(wavHeader(0)));
        }
        await save(join(path, "meta.json"), meta); await save(join(path, "summary.json"), summary);
      }
      controller.signal.throwIfAborted();
      const upstream = httpRequest({ hostname: host, port: upstreamPort, path: url.pathname + url.search, method: req.method,
        headers: { ...headers(req.headers), ...(recording ? { "accept-encoding": "identity" } : {}) }, signal: controller.signal });
      const download = new Promise<void>((resolve, reject) => {
        upstream.once("error", reject);
        upstream.once("response", response => { void (async () => {
          meta.status = response.statusCode ?? 502;
          if (recording && meta.status >= 300 && meta.status < 400) throw new Rejected(502, "upstream_redirect_blocked");
          const outgoing = headers(response.headers);
          // 記録の終了処理に失敗した場合、Content-Lengthだけで成功が確定しないようにする。
          if (recording) delete outgoing["content-length"];
          if (typeof outgoing.location === "string") {
            const destination = new URL(outgoing.location, `http://${host}:${upstreamPort}`);
            if (destination.hostname === host && destination.port === String(upstreamPort)) { destination.port = String(boundPort); outgoing.location = destination.href; }
          }
          if (recording) parser = new ResponseSummary((response.headers["content-type"] ?? "").includes("text/event-stream"), url.pathname === "/api/voice/transcribe", summary, async bytes => {
            if (!audioFile) return;
            await disk(audioFile.writeFile(bytes));
            await disk(audioFile.write(wavHeader(summary.audioBytes + bytes.length), 0, 44, 0));
          });
          if (responseFile && (response.headers["content-type"] ?? "").includes("text/event-stream")) recordedSse = new RecordedSse();
          res.writeHead(meta.status, outgoing);
          for await (const value of response) {
            const bytes = Buffer.from(value);
            meta.firstByteMs ??= Math.round(performance.now() - started);
            if (responseFile) await disk(responseFile.writeFile(recordedSse ? recordedSse.push(bytes) : bytes));
            await parser?.push(bytes);
            await writeTo(res, bytes);
          }
          if (!response.complete) throw new Error("upstream_partial");
          if (responseFile && recordedSse) await disk(responseFile.writeFile(recordedSse.push(Buffer.alloc(0), true)));
          await parser?.finish();
        })().then(resolve, reject); });
      });
      const upload = (async () => {
        for await (const value of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.from(value);
          if (requestFile && url.pathname !== "/api/voice/chat") await disk(requestFile.writeFile(bytes));
          if (recording && url.pathname !== "/api/voice/transcribe" && !requestJsonTooLarge) {
            requestJson += requestDecoder.write(bytes);
            if (requestJson.length > 1_048_576) { requestJson = ""; requestJsonTooLarge = true; }
          }
          await writeTo(upstream, bytes);
        }
        if (!requestJsonTooLarge && requestJson) {
          try {
            const value: unknown = JSON.parse(requestJson + requestDecoder.end());
            if (object(value) && typeof value.message === "string") {
              summary.userText = value.message.slice(0, 100_000);
              if (requestFile && url.pathname === "/api/voice/chat") {
                const recorded = Object.fromEntries(["mode", "message", "history", "speak"].filter(key => key in value).map(key => [key, value[key]]));
                await disk(requestFile.writeFile(JSON.stringify(recorded)));
              }
            }
          } catch (error) { if (error instanceof StorageFailure) throw error; summary.errors.push("invalid_request_json"); }
        }
        upstream.end();
      })();
      try { await Promise.all([upload, download]); }
      catch (error) { controller.abort(); if (!req.complete) req.destroy(); await Promise.allSettled([upload, download]); throw error; }
      meta.completed = !meta.clientAbort;
    } catch (error) {
      controller.abort();
      meta.error = error instanceof StorageFailure ? "recording_storage_failed" : error instanceof Rejected ? error.code : meta.clientAbort ? "client_abort" : "upstream_failed";
      if (!res.headersSent && !res.destroyed) reply(res, error instanceof Rejected ? error.status : error instanceof StorageFailure ? 503 : 502, { error: { code: meta.error } });
      else if (!res.destroyed) res.destroy();
    } finally {
      meta.elapsedMs = Math.round(performance.now() - started);
      try {
        if (recording && path) { await save(join(path, "summary.json"), summary); await save(join(path, "meta.json"), meta); }
        for (const file of files) await disk(file.close());
      } catch { for (const file of files) await file.close().catch(() => {}); if (!res.destroyed) res.destroy(); }
      req.off("aborted", clientAbort); res.off("close", clientAbort);
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.host !== `${host}:${boundPort}` || req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === "host").length !== 1) throw new Rejected(421, "invalid_recording_host");
      if (req.method === "POST" && req.headers.origin !== `http://${host}:${boundPort}`) throw new Rejected(403, "invalid_recording_origin");
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new Rejected(400, "invalid_recording_path");
      const url = new URL(req.url, `http://${host}:${boundPort}`);
      let decoded: string; try { decoded = decodeURIComponent(url.pathname); } catch { throw new Rejected(400, "invalid_recording_path"); }
      if (decoded.startsWith("/__test-recording")) { await local(req, res, new URL(decoded + url.search, url.origin)); return; }
      if (/(?:^|\/)(?:\.local|\.env[^/]*|data|wrangler\.jsonc)(?:\/|$)/i.test(decoded)) throw new Rejected(404, "recording_read_forbidden");
      const recording = req.method === "POST" && apis.has(url.pathname);
      if (!recording && req.method !== "GET" && req.method !== "HEAD") throw new Rejected(405, "recording_method_not_allowed");
      if (recording && !healthy) throw new Rejected(503, "recording_storage_failed");
      await proxy(req, res, url, recording);
    } catch (error) {
      req.resume();
      if (!res.headersSent && !res.destroyed) reply(res, error instanceof Rejected ? error.status : 503, { error: { code: error instanceof Rejected ? error.code : "recording_storage_failed" } });
      else res.destroy();
    }
  };
  const server = createServer((req, res) => {
    const job = handle(req, res); jobs.add(job); void job.finally(() => jobs.delete(job));
  });
  server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("recorder_bind_failed"); boundPort = address.port;
  return { port: boundPort, directory, healthy: () => healthy,
    async close() { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; await Promise.allSettled(jobs); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (!["--port", "--upstream-port", "--directory"].includes(args[index]) || !args[index + 1] || values[args[index]]) throw new Error("invalid_arguments");
      values[args[index]] = args[index + 1];
    }
    for (const key of ["--port", "--upstream-port"]) if (values[key] !== undefined && !/^[1-9]\d*$/.test(values[key])) throw new Error("invalid_port");
    const recorder = await startConversationRecorder({ port: Number(values["--port"] ?? 8788), upstreamPort: Number(values["--upstream-port"] ?? 8789), directory: values["--directory"] });
    process.stdout.write(`Conversation recorder ready: http://${host}:${recorder.port}\n`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void recorder.close().then(() => { process.exitCode = 0; }); });
  } catch { process.stderr.write("Conversation recorder failed; API forwarding is disabled.\n"); process.exitCode = 1; }
}
