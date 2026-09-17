// ローカルCLI。実行前に、送信先・モデル・件数・API呼び出し回数・送信する根拠IDを表示する。
import { loadHistories, planCase, selectCases, promptVersion } from "./lab.mts";
import { appendRetestRecord, buildRunPlan, defaultRetestPath, keepFrozen, loadRetestCases, prepareSnapshotForRetest, runA, runB, runC, type Condition, type RetestCase, type RetestRecord } from "./retest.mts";
import type { HandoffItem } from "./handoff.mts";
import { assertAllowedHost, type ProviderConfig } from "./provider.mts";
import { runCaseA, historyFor } from "./run.mts";
import { appendRecord, defaultRecordsPath, readRecords, summarize, updateLabel } from "./records.mts";
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
    const plan = planCase(item);
    lines.push("- " + plan.caseId + " 送信根拠: " + (plan.sentEvidenceIds.join(",") || "なし")
      + " / 除外: " + (plan.excluded.map(entry => entry.id + "(" + entry.reason + ")").join(",") || "なし")
      + " / 履歴: " + (plan.historyId ?? "なし") + " / 質問: " + plan.question);
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


function printRetest(record: RetestRecord): void {
  const seconds = (record.stage.totalMs / 1000).toFixed(1);
  console.log([
    record.condition + " " + record.caseId + " (順" + String(record.order) + (record.repeat > 1 ? "・反復" + String(record.repeat) : "") + ")"
      + " | " + record.execution.status + (record.execution.errorKind ? "(" + record.execution.errorKind + ")" : "")
      + " | " + record.modelAnswerability + " | " + record.answerStatus
      + " | " + seconds + "秒 | 根拠" + String(record.evidenceIds.length) + "件 | API" + String(record.execution.apiCalls)
      + " | 生成" + record.stage.generationMs.join("+") + "ms 校閲" + (record.stage.verificationMs.join("+") || "0") + "ms"
      + " | tokens " + String(record.usage.inputTokens) + "/" + String(record.usage.outputTokens),
    "  回答: " + (record.answer || "(なし)").slice(0, 180),
    record.pipelineLog.mechanicalCheck ? "  機械確認/校閲: " + record.pipelineLog.mechanicalCheck : ""
  ].filter(line => line !== "").join(String.fromCharCode(10)));
}

async function runRetestCommand(args: Args): Promise<number> {
  const all = loadRetestCases();
  const ids = caseIds(args);
  const picked = ids.length ? all.filter(item => ids.includes(item.id)) : all.filter(item => item.kind === "main");
  if (!picked.length) throw new Error("ケースが見つかりません。");
  const conditions = text(args, "conditions", "A,B,C").split(",").map(value => value.trim().toUpperCase())
    .filter((value): value is Condition => value === "A" || value === "B" || value === "C");
  if (!conditions.length) throw new Error("条件はA,B,Cのいずれかです。");
  const repeat = Math.max(1, Math.min(5, number(args, "repeat", 1)));
  const order = text(args, "order", "interleave") === "random" ? "random" : "interleave";
  const path = text(args, "out", process.env.LAB_RETEST ?? defaultRetestPath());
  const rounds = text(args, "rounds", "").split(",").map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  const plan = buildRunPlan(picked, conditions, repeat, order).filter(step => !rounds.length || rounds.includes(step.repeat));
  // dry-runではキー無しでも計画だけを出せるようにする。
  const config = args["dry-run"] === true && !process.env.LAB_API_KEY
    ? { baseUrl: process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1", apiKey: "dry-run",
        model: text(args, "model", process.env.LAB_MODEL ?? "glm-5.3-flash"), session: "ai-mendan-kun-lab",
        temperature: number(args, "temperature", 0), maxTokens: number(args, "max-tokens", 2048),
        timeoutMs: number(args, "timeout-ms", 60_000) }
    : providerConfig(args);
  const worst = plan.reduce((sum, step) => sum + (step.condition === "C" ? 4 : 1), 0);
  console.log("== 再試験の実行予定 ==");
  console.log("保存先: " + path);
  console.log("送信先: " + config.baseUrl + " / モデル: " + config.model + " / temperature: " + String(config.temperature));
  console.log("条件実行: " + String(plan.length) + "件（" + conditions.join("/") + " × " + String(picked.length) + "ケース" + (rounds.length ? "・反復" + rounds.join(",") : " × " + String(repeat) + "反復") + "）");
  console.log("API呼び出し見込み: " + String(plan.length) + "〜" + String(worst) + "回（A=1、B=1、C=1〜4。Cは作り直しで増える）");
  console.log("根拠: 同一スナップショット（架空1名）。ベクトル経路は " + text(args, "vector", "hash") + "（本番はbge-m3+Vectorize）");
  if (args["dry-run"] === true) { console.log("--dry-run のため送信しません。"); return 0; }
  const snapshot = await prepareSnapshotForRetest({ vectorChannel: text(args, "vector", "hash") !== "off" });
  console.log("スナップショット: " + snapshot.hash.slice(0, 12) + " / チャンク " + String(snapshot.chunks.length) + "件");
  const collected = new Map<string, HandoffItem[]>();
  const frozen: Record<string, { items: HandoffItem[]; fromRunId: string | null }> = {};
  let sequence = 0, failures = 0;
  for (const step of plan) {
    const item = picked.find(candidate => candidate.id === step.caseId) as RetestCase;
    sequence += 1;
    const meta = { repeat: step.repeat, order: sequence };
    const record = step.condition === "A" ? await runA(item, snapshot, config, meta)
      : step.condition === "B" ? await runB(item, snapshot, config, meta, collected)
      : await runC(item, snapshot, config, frozen[item.id] ?? { items: [], fromRunId: null }, meta);
    if (step.condition === "B" && collected.has(item.id)) {
      frozen[item.id] = { items: keepFrozen(collected.get(item.id) ?? []), fromRunId: record.runId };
    }
    appendRetestRecord(path, record);
    printRetest(record);
    if (record.execution.status !== "ok") failures += 1;
  }
  console.log("保存しました: " + path + "（失敗 " + String(failures) + "件）");
  return failures && args["allow-errors"] !== true ? 1 : 0;
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
  if (command === "retest") return runRetestCommand(args);
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
    "  node experiments/conversation-lab/src/cli.mts retest [--cases M01,M02] [--conditions A,B,C] [--repeat 3] [--rounds 2,3] [--order interleave|random] [--dry-run] [--vector hash|off]",
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
