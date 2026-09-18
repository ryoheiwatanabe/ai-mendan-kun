import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { Readable } from "node:stream";

// 鍵は起動時にキーチェーン等からプロセスへ渡す。ファイル・URL・ブラウザへ出さない。
const target = new URL(process.env.MENDAN_PREVIEW_URL ?? "");
const token = process.env.MENDAN_PREVIEW_TOKEN;
const port = Number(process.env.MENDAN_PREVIEW_PORT ?? "8790");
// 実行ログの保存先。指定があれば1要求1行で追記する。質問・回答・根拠の本文は保存しない。
const logPath = process.env.MENDAN_PREVIEW_LOG ?? "";
if (target.protocol !== "https:" || !target.hostname.endsWith(".workers.dev") || target.pathname !== "/"
  || target.search || target.username || target.password || !token || token.length < 32
  || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_preview_configuration");
const origin = `http://127.0.0.1:${port}`;
const blocked = new Set(["host", "connection", "transfer-encoding", "content-length", "content-encoding", "cookie", "authorization", "x-mendan-preview"]);
const watched = new Set(["/api/chat", "/api/voice/chat"]);

// 回答に関わる要求だけを見張り、出来事の種類・失敗コード・段階・所要時間だけを集める。
// 本文は一切残さないので、質問や回答の中身は記録されない。
function inspect(pathname, status, contentType) {
  const record = { path: pathname, status, events: {}, error: null, trace: null, answerChars: 0, audioFrames: 0 };
  if (!contentType.includes("text/event-stream")) return { record, stream: null };
  const decoder = new TextDecoder();
  let buffer = "";
  const count = (line) => {
    if (!line.startsWith("data: ")) return;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { return; }
    if (!event || typeof event.type !== "string") return;
    record.events[event.type] = (record.events[event.type] ?? 0) + 1;
    if (event.type === "text" && typeof event.text === "string") record.answerChars += event.text.length;
    if (event.type === "audio") record.audioFrames += 1;
    if (event.type === "error") record.error = typeof event.code === "string" ? event.code : "unknown";
    if (event.type === "trace" && Array.isArray(event.trace)) record.trace = event.trace.map(entry => ({ code: entry.code,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      ...(typeof entry.ms === "number" ? { ms: entry.ms } : {}) }));
  };
  const stream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) count(line);
      controller.enqueue(chunk);
    },
    flush() { count(buffer); buffer = ""; }
  });
  return { record, stream };
}

async function writeLog(record, durationMs, delivered) {
  const entry = { at: new Date().toISOString(), ...record, durationMs, delivered };
  console.log(`AI面談くん: ${entry.path} ${entry.status} ${durationMs}ms${entry.error ? ` error=${entry.error}` : ""}`
    + ` events=${JSON.stringify(entry.events)}`);
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify(entry)}\n`).catch(() => {});
}

// 上流の本文をそのまま流し、送信が終わるか相手が切るまで待つ。
async function forward(body, outgoing) {
  const source = Readable.fromWeb(body);
  await new Promise(resolve => {
    for (const event of ["finish", "close", "error"]) outgoing.once(event, resolve);
    source.once("error", resolve);
    source.pipe(outgoing);
  });
}

createServer(async (incoming, outgoing) => {
  const cancel = new AbortController();
  outgoing.on("close", () => { if (!outgoing.writableEnded) cancel.abort(); });
  const requestedAt = performance.now();
  let record = null, stream = null;
  try {
    if (incoming.headers.host !== `127.0.0.1:${port}`
      || incoming.headers.origin && incoming.headers.origin !== origin
      || incoming.headers["sec-fetch-site"] === "cross-site") {
      outgoing.writeHead(403); outgoing.end("Forbidden"); return;
    }
    const url = new URL(incoming.url ?? "/", origin);
    if (url.origin !== origin) { outgoing.writeHead(403); outgoing.end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (!blocked.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("origin", target.origin);
    headers.set("x-mendan-preview", token);
    headers.set("accept-encoding", "identity");
    const response = await fetch(new URL(url.pathname + url.search, target), {
      method: incoming.method, headers, redirect: "manual", signal: cancel.signal,
      ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: Readable.toWeb(incoming), duplex: "half" })
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (watched.has(url.pathname)) {
      const inspected = inspect(url.pathname, response.status, contentType);
      record = inspected.record; stream = inspected.stream;
      // ストリームでない応答（受付前の見送りなど）は、本文を保存せず失敗コードだけを取る。
      if (!stream) {
        try { const body = await response.clone().json(); record.error = body?.error?.code ?? null; } catch {}
      }
    }
    const resultHeaders = {};
    for (const [name, value] of response.headers) if (!blocked.has(name) && name !== "set-cookie") resultHeaders[name] = value;
    resultHeaders["cache-control"] = "no-store";
    if (resultHeaders.location?.startsWith(target.origin)) resultHeaders.location = resultHeaders.location.replace(target.origin, origin);
    outgoing.writeHead(response.status, resultHeaders);
    if (response.body) {
      const body = stream ? response.body.pipeThrough(stream) : response.body;
      await forward(body, outgoing);
    } else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
    if (record) record.error = record.error ?? "preview_unavailable";
  } finally {
    if (record) await writeLog(record, Math.round(performance.now() - requestedAt), outgoing.writableEnded);
  }
}).listen(port, "127.0.0.1", () => console.log(`AI面談くん: ${origin}`));
