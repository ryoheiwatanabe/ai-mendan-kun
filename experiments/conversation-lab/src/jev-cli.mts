// D条件の実行用CLI。保存済み候補に対する、現行校閲とJEVの判定比較。
// 実行前に、送信先・モデル・対象件数・呼び出し上限・保存先・根拠が引けない候補を表示する。
import { appendRetestRecord, baseSha, defaultRetestPath, prepareSnapshotForRetest } from "./retest.mts";
import { candidatesFromRecords, compareCandidate, jevPlan, retestRecords, savedEvidenceItems } from "./modeD.mts";
import { OpenCodeProvider } from "../../../lib/ai/opencode.ts";

const args = new Map<string, string | true>();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) args.set(token.slice(2), true);
  else { args.set(token.slice(2), next); index += 1; }
}
const flag = (name: string, fallback: string) => {
  const value = args.get(name);
  return typeof value === "string" ? value : fallback;
};
const number = (name: string, fallback: number) => {
  const value = args.get(name);
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const source = flag("source", process.env.LAB_RETEST ?? defaultRetestPath());
const out = flag("out", process.env.LAB_JEV_RECORDS ?? source.replace("retest.jsonl", "jev.jsonl"));
const resolvedSource = new URL("file://" + source).pathname;
const resolvedOut = new URL("file://" + out).pathname;
if (resolvedSource === resolvedOut) {
  console.error("エラー: 保存先が入力と同じパスです（--out を分けてください）。旧記録を汚染しません。");
  process.exit(2);
}
const limit = Math.max(1, Math.min(20, number("limit", 4)));
const caseIds = flag("cases", "").split(",").map(value => value.trim()).filter(Boolean);
const useJev = args.get("no-jev") !== true;
const plan = jevPlan();
const { candidates, dropped } = await candidatesFromRecords(retestRecords(source), caseIds);
const picked = candidates.slice(0, limit);
const baseUrl = process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const model = flag("model", process.env.LAB_MODEL ?? "glm-5.3-flash");

const lines = [
  "== D条件（同一候補への校閲比較）の実行予定 ==",
  "候補の元: " + source + "（保存済みの再試験記録。回答の再生成はしない）",
  "現行校閲: モデル " + model + " / 送信先 " + baseUrl + "（構造化候補を渡す）",
  "JEV: 送信先 " + plan.endpoint + " / モデル " + plan.model + "（平文候補を渡す） / 判定項目 " + plan.questions.join(","),
  "対象候補: " + String(candidates.length) + "件（内容hashで重複を除去）。今回は " + String(picked.length) + "件"
];
if (dropped.length) lines.push("取り出せなかった記録: " + String(dropped.length) + "件");
if (useJev && !process.env.TYPESAFE_API_KEY) lines.push("注意: TYPESAFE_API_KEY が未設定です（--no-jev なら現行校閲だけを実行）。");
console.log(lines.join(String.fromCharCode(10)));
if (args.get("dry-run") === true) { console.log("--dry-run のため送信しません。"); process.exit(0); }
if (!picked.length) { console.log("比較できる候補がありません。"); process.exit(0); }

const apiKey = process.env.LAB_API_KEY ?? "";
if (!apiKey) { console.error("エラー: LAB_API_KEY が未設定です。"); process.exit(2); }
const provider = new OpenCodeProvider(apiKey, model,
  process.env.LAB_OPENCODE_JSON_MODE === "object" ? "object" : "schema", process.env.LAB_SESSION ?? "ai-mendan-kun-lab");
const snapshot = await prepareSnapshotForRetest({ vectorChannel: false });
const commit = baseSha();
let failures = 0;
let calls = 0;
for (const candidate of picked) {
  const { items, missing } = savedEvidenceItems(snapshot, candidate.evidenceIds);
  if (missing.length) {
    console.log([candidate.caseId + " " + candidate.kind + "（元 " + candidate.sourceRunId.slice(0, 8) + "）",
      String.fromCharCode(10) + "  送信せずに終了: 根拠を引けないID " + String(missing.length) + "件（" + missing.slice(0, 2).join(",") + "）",
      String.fromCharCode(10) + "  呼び出し: 現行校閲0回 / JEV0回"].join(""));
    failures += 1;
    continue;
  }
  const checked = await (await import("./handoff.mts")).assertPublicNow(snapshot.repository as unknown as import("../../../lib/knowledge/repository.ts").KnowledgeRepository, items);
  if (checked.dropped.length) {
    console.log(candidate.caseId + " " + candidate.kind + " 送信せずに終了: 送信直前の確認で除外 "
      + String(checked.dropped.length) + "件（" + checked.dropped.map(entry => entry.id + ":" + entry.reason).join(",") + "）");
    failures += 1;
    continue;
  }
  const record = await compareCandidate({ candidate, items: checked.kept, snapshotHash: snapshot.hash, baseSha: commit,
    provider, timeoutMs: number("timeout-ms", 60_000), useJev });
  appendRetestRecord(out, record as never);
  calls += record.current.executionStatus === "not_run" ? 0 : 1;
  calls += record.jev.executionStatus === "not_run" ? 0 : 1;
  const jevText = record.jev.executionStatus === "ok"
    ? Object.entries(record.jev.answers).map(([key, value]) =>
        key + "=" + (value.probability === null ? "?" : value.probability.toFixed(2))).join(" ")
    : "judge_error(" + String(record.jev.errorKind) + ")";
  const currentText = record.current.executionStatus === "ok"
    ? (record.current.verdict === "accepted" ? "合格" : "却下(" + String(record.current.reason) + ")")
    : "実行エラー(" + String(record.current.errorKind) + ")";
  console.log([record.caseId + " " + record.candidateKind + "（元 " + record.sourceRunId.slice(0, 8) + "）",
    String.fromCharCode(10) + "  候補: " + record.candidate.slice(0, 120).replace(String.fromCharCode(10), " "),
    String.fromCharCode(10) + "  現行校閲: " + currentText + " / " + String(record.current.latencyMs) + "ms / tokens "
      + String(record.current.inputTokens) + "/" + String(record.current.outputTokens),
    String.fromCharCode(10) + "  JEV: " + jevText + " / " + String(record.jev.latencyMs) + "ms（ヘッダー "
      + String(record.jev.responseHeadersMs) + "ms）/ tokens " + String(record.jev.inputTokens) + "/" + String(record.jev.outputTokens)
      + " / 返却モデル " + String(record.jev.returnedModel),
    record.notes.length ? String.fromCharCode(10) + "  注意: " + record.notes.join(" ") : ""
  ].join(""));
  if (record.current.executionStatus === "error" || record.jev.executionStatus === "error") failures += 1;
}
console.log("保存しました: " + out + "（呼び出し " + String(calls) + "回 / 失敗 " + String(failures) + "件）");
process.exit(failures ? 1 : 0);
