// ローカル専用の画面。127.0.0.1だけにバインドし、外部公開しない。
// キーはサーバーの環境変数から読み、ブラウザへ渡さない。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCases, loadHistories, loadProfile, planCase, promptVersion, sanitizeOverrides } from "./lab.mts";
import { assertAllowedHost, type ProviderConfig } from "./provider.mts";
import { appendRecord, defaultRecordsPath, readRecords, summarize, updateLabel } from "./records.mts";
import { runCaseA } from "./run.mts";
import type { CaseInput, CasePlan } from "./lab.mts";
import type { RunRecord } from "./types.mts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.LAB_PORT ?? 8788);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const recordsPath = process.env.LAB_RECORDS ?? defaultRecordsPath();
const maxCasesPerRun = Number(process.env.LAB_MAX_CASES ?? 20);
const staticFiles: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css"
};

// 外部から届いた要求は処理しない。接続元とHostの両方でローカルに限定する。
export function isLocalRequest(remoteAddress: string | undefined, hostHeader: string | undefined): boolean {
  const remote = remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return false;
  const name = (hostHeader ?? "").replace(/^\[/, "").split(":")[0].replace(/\]$/, "");
  return ["127.0.0.1", "localhost", "::1"].includes(name);
}

function configFor(model?: unknown): ProviderConfig {
  const apiKey = process.env.LAB_API_KEY ?? "";
  if (!apiKey) throw new Error("LAB_API_KEY が未設定です（サーバーの環境変数で渡してください）。");
  const baseUrl = process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1";
  const allowed = (process.env.LAB_ALLOWED_HOSTS ?? "opencode.ai").split(",").map(host => host.trim()).filter(Boolean);
  assertAllowedHost(baseUrl, allowed);
  const picked = typeof model === "string" && model.length ? model : process.env.LAB_MODEL ?? "glm-5.3-flash";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(picked)) throw new Error("invalid_model");
  return {
    baseUrl,
    apiKey,
    model: picked,
    session: process.env.LAB_SESSION ?? "ai-mendan-kun-lab",
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: Number(process.env.LAB_TIMEOUT_MS ?? 60_000)
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 262_144) throw new Error("body_too_large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function caseInputs(value: unknown): { item: ReturnType<typeof loadCases>[number]; overrides: Partial<CaseInput> }[] {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requested = Array.isArray(body.cases) ? body.cases : [];
  const cases = loadCases();
  const picked: { item: ReturnType<typeof loadCases>[number]; overrides: Partial<CaseInput> }[] = [];
  for (const entry of requested) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const item = cases.find(candidate => candidate.id === record.caseId);
    if (!item) continue;
    picked.push({ item, overrides: sanitizeOverrides(record) });
  }
  if (!picked.length) throw new Error("no_cases");
  if (picked.length > maxCasesPerRun) throw new Error("too_many_cases: " + String(maxCasesPerRun));
  return picked;
}

function planFor(picked: { item: ReturnType<typeof loadCases>[number]; overrides: Partial<CaseInput> }[]): CasePlan[] {
  const profile = loadProfile();
  return picked.map(entry => planCase(entry.item, entry.overrides, profile));
}

let activeController: AbortController | null = null;

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://" + HOST);
  if (request.method === "GET" && staticFiles[url.pathname]) {
    const file = await readFile(publicDir + staticFiles[url.pathname]);
    const type = url.pathname.endsWith(".css") ? "text/css; charset=utf-8"
      : url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(file);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, {
      model: process.env.LAB_MODEL ?? "glm-5.3-flash",
      baseUrl: process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1",
      promptVersion,
      recordsPath,
      maxCasesPerRun,
      keyConfigured: Boolean(process.env.LAB_API_KEY),
      modes: [
        { id: "A", label: "A: 人が選んだ根拠＋単発生成", ready: true },
        { id: "B", label: "B: 現行検索＋単発生成", ready: false },
        { id: "C", label: "C: 固定根拠＋現行の生成・校閲", ready: false },
        { id: "D", label: "D: 同一候補への校閲比較", ready: false }
      ],
      jev: { status: "not_configured", note: "Jevの鍵と送信許可が未設定のため、Aモードのみ動きます。" },
      subjectId: loadProfile().subjectId,
      cases: loadCases(),
      histories: loadHistories(),
      evidence: loadProfile().evidence
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/records") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 20)));
    sendJson(response, 200, { records: readRecords(recordsPath).slice(-limit), summary: summarize(readRecords(recordsPath)) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/export") {
    const lines = readRecords(recordsPath).map(record => JSON.stringify(record)).join(String.fromCharCode(10));
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": "attachment; filename=conversation-lab-records.jsonl" });
    response.end(lines + (lines ? String.fromCharCode(10) : ""));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/abort") {
    activeController?.abort();
    sendJson(response, 200, { aborted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/label") {
    const body = await readBody(request) as Record<string, unknown>;
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) throw new Error("missing_run_id");
    const pick = (value: unknown) => typeof value === "string" && ["ok", "ng", "?"].includes(value) ? value : "?";
    const updated = updateLabel(recordsPath, runId, {
      targetMatch: pick(body.targetMatch),
      aspectMatch: pick(body.aspectMatch),
      supported: pick(body.supported),
      notes: typeof body.notes === "string" ? body.notes.slice(0, 500) : "",
      at: new Date().toISOString()
    });
    sendJson(response, 200, { updated });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plan") {
    const picked = caseInputs(await readBody(request));
    sendJson(response, 200, { plans: planFor(picked), apiCalls: picked.length,
      model: process.env.LAB_MODEL ?? "glm-5.3-flash", baseUrl: process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/run") {
    const body = await readBody(request) as Record<string, unknown>;
    const picked = caseInputs(body);
    const config = configFor(body.model);
    if (body.temperature !== undefined) config.temperature = Math.max(0, Math.min(2, Number(body.temperature) || 0));
    if (body.maxTokens !== undefined) config.maxTokens = Math.max(64, Math.min(8192, Number(body.maxTokens) || 2048));
    if (body.timeoutMs !== undefined) config.timeoutMs = Math.max(500, Math.min(180_000, Number(body.timeoutMs) || 60_000));
    const plans = planFor(picked);
    if (body.dryRun === true) {
      sendJson(response, 200, { dryRun: true, plans, apiCalls: picked.length, model: config.model, baseUrl: config.baseUrl });
      return;
    }
    if (activeController) {
      sendJson(response, 409, { error: "run_in_progress" });
      return;
    }
    activeController = new AbortController();
    const controller = activeController;
    const records: RunRecord[] = [];
    const disconnect = () => controller.abort();
    request.on("close", disconnect);
    // 1件ごとに結果を流す。待ち時間が見えるようにし、途中でも中止できるようにする。
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    const emit = (value: unknown) => response.write(JSON.stringify(value) + String.fromCharCode(10));
    emit({ type: "plan", plans, apiCalls: picked.length, model: config.model, baseUrl: config.baseUrl });
    try {
      for (const entry of picked) {
        if (controller.signal.aborted) break;
        const record = await runCaseA(entry.item, config, { overrides: entry.overrides, signal: controller.signal });
        appendRecord(recordsPath, record);
        records.push(record);
        emit({ type: "record", record });
      }
    } finally {
      request.off("close", disconnect);
      activeController = null;
    }
    emit({ type: "done", summary: summarize(records), aborted: controller.signal.aborted });
    response.end();
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  if (!isLocalRequest(request.socket.remoteAddress, request.headers.host)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ローカルからのみ利用できます。");
    return;
  }
  handle(request, response).catch(error => {
    const message = error instanceof Error ? error.message : "unknown";
    sendJson(response, message.startsWith("host_not_allowed") || message === "invalid_model" ? 400 : 500, { error: message });
  });
});

// 直接起動したときだけ待ち受ける（試験のために読み込むだけでは起動しない）。
const startedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (startedDirectly) {
  server.listen(PORT, HOST, () => {
    console.log("ラボ画面: http://" + HOST + ":" + String(PORT) + "/");
    console.log("記録: " + recordsPath + " / モデル: " + (process.env.LAB_MODEL ?? "glm-5.3-flash")
      + " / キー: " + (process.env.LAB_API_KEY ? "設定済み" : "未設定（Aモードは動きません）"));
  });
}
