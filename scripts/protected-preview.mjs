import { createServer } from "node:http";
import { Readable } from "node:stream";

// 鍵は起動時にキーチェーン等からプロセスへ渡す。ファイル・URL・ブラウザへ出さない。
const target = new URL(process.env.MENDAN_PREVIEW_URL ?? "");
const token = process.env.MENDAN_PREVIEW_TOKEN;
const port = Number(process.env.MENDAN_PREVIEW_PORT ?? "8790");
if (target.protocol !== "https:" || !target.hostname.endsWith(".workers.dev") || target.pathname !== "/"
  || target.search || target.username || target.password || !token || token.length < 32
  || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_preview_configuration");
const origin = `http://127.0.0.1:${port}`;
const blocked = new Set(["host", "connection", "transfer-encoding", "content-length", "content-encoding", "cookie", "authorization", "x-mendan-preview"]);
createServer(async (incoming, outgoing) => {
  const cancel = new AbortController();
  outgoing.on("close", () => { if (!outgoing.writableEnded) cancel.abort(); });
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
    const resultHeaders = {};
    for (const [name, value] of response.headers) if (!blocked.has(name) && name !== "set-cookie") resultHeaders[name] = value;
    resultHeaders["cache-control"] = "no-store";
    if (resultHeaders.location?.startsWith(target.origin)) resultHeaders.location = resultHeaders.location.replace(target.origin, origin);
    outgoing.writeHead(response.status, resultHeaders);
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  }
}).listen(port, "127.0.0.1", () => console.log(`AI面談くん: ${origin}`));
