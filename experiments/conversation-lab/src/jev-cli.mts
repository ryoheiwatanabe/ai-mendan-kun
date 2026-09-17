// D条件の実行用CLI。保存済み候補に対する、現行校閲とJEVの判定比較。
// 実行前に、送信先・モデル・対象件数・呼び出し上限・保存先を表示する。
import { appendRetestRecord, defaultRetestPath } from "./retest.mts";
import { candidatesFromRecords, compareCandidate, jevPlan, retestRecords } from "./modeD.mts";
import { prepareSnapshotForRetest } from "./retest.mts";
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
const limit = Math.max(1, Math.min(20, number("limit", 4)));
const caseIds = flag("cases", "").split(",").map(value => value.trim()).filter(Boolean);
const useJev = args.get("no-jev") !== true;
const plan = jevPlan();
const all = candidatesFromRecords(retestRecords(source), caseIds);
const picked = all.slice(0, limit);
const baseUrl = process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const model = flag("model", process.env.LAB_MODEL ?? "glm-5.3-flash");

const lines = [
  "== D条件（同一候補への校閲比較）の実行予定 ==",
  "候補の元: " + source + "（保存済みの再試験記録。回答の再生成はしない）",
  "現行校閲: モデル " + model + " / 送信先 " + baseUrl,
  "JEV: 送信先 " + plan.endpoint + " / モデル " + plan.model + " / 判定項目 " + plan.questions.join(","),
  "対象候補: " + String(all.length) + "件（同じケース・種類・本文の重複を除く）。今回は " + String(picked.length) + "件",
  "呼び出し上限: 現行校閲 " + String(picked.length) + "回 / JEV " + String(useJev ? picked.length : 0) + "回",
  "保存先: " + out
];
if (useJev && !process.env.TYPESAFE_API_KEY) lines.push("注意: TYPESAFE_API_KEY が未設定です（--no-jev なら現行校閲だけを実行します）。");
console.log(lines.join(String.fromCharCode(10)));
if (args.get("dry-run") === true) { console.log("--dry-run のため送信しません。"); process.exit(0); }
if (!picked.length) { console.log("比較できる候補がありません。"); process.exit(0); }

const apiKey = process.env.LAB_API_KEY ?? "";
if (!apiKey) { console.error("エラー: LAB_API_KEY が未設定です。"); process.exit(2); }
const provider = new OpenCodeProvider(apiKey, model,
  process.env.LAB_OPENCODE_JSON_MODE === "object" ? "object" : "schema", process.env.LAB_SESSION ?? "ai-mendan-kun-lab");
const snapshot = await prepareSnapshotForRetest({ vectorChannel: false });
let failures = 0;
for (const candidate of picked) {
  const evidence = await snapshot.repository.resolve(candidate.evidenceIds);
  const record = await compareCandidate({ candidate, evidence, provider, timeoutMs: number("timeout-ms", 60_000), useJev });
  appendRetestRecord(out, record as never);
  const jevText = record.jev.ok
    ? Object.entries(record.jev.answers).map(([key, value]) =>
        key + "=" + (value.probability === null ? "?" : value.probability.toFixed(2))).join(" ")
    : "judge_error(" + String(record.jev.errorKind) + ")";
  console.log([
    record.caseId + " " + record.candidateKind + "（元 " + record.sourceRunId.slice(0, 8) + "）",
    String.fromCharCode(10) + "  候補: " + record.candidate.slice(0, 120).replace(String.fromCharCode(10), " "),
    String.fromCharCode(10) + "  現行校閲: " + (record.current.ok ? "合格" : "却下(" + String(record.current.reason) + ")")
      + " / " + String(record.current.latencyMs) + "ms / tokens " + String(record.current.inputTokens) + "/" + String(record.current.outputTokens),
    String.fromCharCode(10) + "  JEV: " + jevText + " / " + String(record.jev.latencyMs) + "ms / tokens "
      + String(record.jev.usage.inputTokens) + "/" + String(record.jev.usage.outputTokens),
    record.notes.length ? String.fromCharCode(10) + "  注意: " + record.notes.join(" ") : ""
  ].join(""));
  if (!record.current.ok && record.current.errorKind) failures += 1;
  if (useJev && !record.jev.ok) failures += 1;
}
console.log("保存しました: " + out + "（失敗 " + String(failures) + "件）");
process.exit(failures ? 1 : 0);
