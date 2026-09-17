// ローカルCLI。実行前に、送信先・モデル・件数・API呼び出し回数・送信する根拠IDを表示する。
import { loadHistories, loadProfile, selectCases, promptVersion } from "./lab.mts";
import { assertAllowedHost, type ProviderConfig } from "./provider.mts";
import { runCaseA, historyFor } from "./run.mts";
import { appendRecord, defaultRecordsPath, readRecords, summarize, updateLabel } from "./records.mts";
import { filterEvidence } from "./lab.mts";
import type { RunRecord } from "./types.mts";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return { command, args };
}

function text(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function number(args: Args, key: string, fallback: number): number {
  const value = args[key];
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function caseIds(args: Args): string[] {
  const value = text(args, "cases", "");
  return value ? value.split(",").map(item => item.trim()).filter(Boolean) : [];
}

function providerConfig(args: Args): ProviderConfig {
  const apiKey = process.env.LAB_API_KEY ?? "";
  if (!apiKey) throw new Error("LAB_API_KEY を環境変数で渡してください（キーは表示しません）。");
  const baseUrl = text(args, "base-url", process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1");
  const allowed = (process.env.LAB_ALLOWED_HOSTS ?? "opencode.ai").split(",").map(host => host.trim()).filter(Boolean);
  assertAllowedHost(baseUrl, allowed);
  return {
    baseUrl,
    apiKey,
    model: text(args, "model", process.env.LAB_MODEL ?? "glm-5.3-flash"),
    session: process.env.LAB_SESSION ?? "ai-mendan-kun-lab",
    temperature: number(args, "temperature", 0),
    maxTokens: number(args, "max-tokens", 2048),
    timeoutMs: number(args, "timeout-ms", 60_000)
  };
}

function recordsPath(args: Args): string {
  return text(args, "out", process.env.LAB_RECORDS ?? defaultRecordsPath());
}

function printPlan(cases: ReturnType<typeof selectCases>, config: ProviderConfig | null, path: string, dryRun: boolean): void {
  const profile = loadProfile();
  const histories = loadHistories();
  const lines: string[] = [];
  lines.push("== 実行予定 ==");
  lines.push("保存先: " + path);
  if (config) {
    lines.push("送信先: " + config.baseUrl + " / モデル: " + config.model + " / temperature: " + String(config.temperature));
    lines.push("API呼び出し: " + String(cases.length) + "件（1ケース1回。検索・校閲・修復は行わない）");
  } else {
    lines.push("API呼び出し: 0件（planのみ）");
  }
  lines.push("プロンプト版: " + promptVersion + " / 履歴: " + String(Object.keys(histories).length) + "種");
  for (const item of cases) {
    const { usable, excluded } = filterEvidence(profile, item.selection);
    lines.push("- " + item.id + " 送信根拠: " + (usable.map(unit => unit.id).join(",") || "なし")
      + " / 除外: " + (excluded.map(entry => entry.id + "(" + entry.reason + ")").join(",") || "なし")
      + " / 履歴: " + (item.historyId ?? "なし") + " / 質問: " + item.question);
  }
  if (dryRun) lines.push("--dry-run のため送信しません。");
  console.log(lines.join(String.fromCharCode(10)));
}

function printRun(record: RunRecord): void {
  const seconds = (record.timing.totalMs / 1000).toFixed(1);
  const usage = record.usage.inputTokens === null ? "usage未取得" : String(record.usage.inputTokens) + "/" + String(record.usage.outputTokens);
  console.log([
    record.caseId + " | " + record.status + (record.errorKind ? "(" + record.errorKind + ")" : "")
      + " | " + seconds + "秒 | 初回トークン " + (record.timing.firstTokenMs === null ? "なし" : String(record.timing.firstTokenMs) + "ms")
      + " | tokens " + usage + " | 根拠 " + record.sentEvidenceIds.join(","),
    "  回答: " + (record.answer || "(なし)").slice(0, 200),
    "  不足: " + (record.limitations || "(なし)")
  ].join(String.fromCharCode(10)));
}

function printList(records: RunRecord[], limit: number): void {
  for (const record of records.slice(-limit)) {
    console.log(record.runId.slice(0, 8) + " | " + record.at + " | " + record.caseId + " | " + record.status
      + (record.errorKind ? "(" + record.errorKind + ")" : "") + " | " + String(record.timing.totalMs) + "ms"
      + " | ラベル " + (record.label ? "あり" : "なし"));
  }
}

async function main(): Promise<number> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const path = recordsPath(args);
  if (command === "plan") {
    printPlan(selectCases(caseIds(args)), null, path, true);
    return 0;
  }
  if (command === "run") {
    const cases = selectCases(caseIds(args));
    const config = providerConfig(args);
    printPlan(cases, config, path, args["dry-run"] === true);
    if (args["dry-run"] === true) return 0;
    let failures = 0;
    for (const item of cases) {
      const record = await runCaseA(item, config);
      appendRecord(path, record);
      printRun(record);
      if (record.status !== "ok") failures += 1;
    }
    console.log("保存しました: " + path);
    return failures && args["allow-errors"] !== true ? 1 : 0;
  }
  if (command === "label") {
    const runId = text(args, "run", "");
    if (!runId) throw new Error("--run <runId> が必要です。");
    const records = readRecords(path);
    const target = records.find(record => record.runId.startsWith(runId));
    if (!target) throw new Error("runId が見つかりません: " + runId);
    const updated = updateLabel(path, target.runId, {
      targetMatch: text(args, "target", "?"),
      aspectMatch: text(args, "aspect", "?"),
      supported: text(args, "supported", "?"),
      notes: text(args, "notes", ""),
      at: new Date().toISOString()
    });
    console.log((updated ? "ラベルを記録しました: " : "更新できませんでした: ") + target.runId);
    return updated ? 0 : 1;
  }
  if (command === "list") {
    printList(readRecords(path), number(args, "limit", 10));
    return 0;
  }
  if (command === "stats") {
    console.log(JSON.stringify(summarize(readRecords(path)), null, 2));
    return 0;
  }
  console.log([
    "使い方:",
    "  node experiments/conversation-lab/src/cli.mts plan [--cases T01,T02]",
    "  node experiments/conversation-lab/src/cli.mts run [--cases ...] [--dry-run] [--model ...] [--temperature 0] [--timeout-ms 60000] [--out PATH]",
    "  node experiments/conversation-lab/src/cli.mts label --run <runId> --target ok|ng|? --aspect ok|ng|? --supported ok|ng|? [--notes TEXT]",
    "  node experiments/conversation-lab/src/cli.mts list [--limit 10]",
    "  node experiments/conversation-lab/src/cli.mts stats",
    "環境変数: LAB_API_KEY（必須）, LAB_BASE_URL, LAB_MODEL, LAB_SESSION, LAB_ALLOWED_HOSTS, LAB_RECORDS"
  ].join(String.fromCharCode(10)));
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("エラー: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
});
