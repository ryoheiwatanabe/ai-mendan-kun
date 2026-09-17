// D条件の実行用CLI。保存済み候補に対する、現行校閲とJEVの判定比較。
// 実行前に、送信先・モデル・対象件数・呼び出し上限・保存先・根拠の状態を表示する。
// 送信前の確認で停止した場合は、両API 0回の not_run として記録する。
import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { appendRetestRecord, baseSha, defaultRetestPath, prepareSnapshotForRetest } from "./retest.mts";
import { candidatesFromRecords, compareCandidate, finalizeCandidates, jevPlan, notRunRecord, retestRecords, runComparisons, type FinalCandidate } from "./modeD.mts";
import { toEvidence } from "./handoff.mts";
import { assertPublicNow } from "./handoff.mts";
import { OpenCodeProvider } from "../../../lib/ai/opencode.ts";
import type { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";
import type { ModelPayload } from "../../../lib/types.ts";

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
const textOfPayload = (payload: string) => {
  try {
    return (JSON.parse(payload) as ModelPayload).segments.map(segment => segment.text).join(String.fromCharCode(10));
  } catch {
    return "(候補を解析できない)";
  }
};

const source = flag("source", process.env.LAB_RETEST ?? defaultRetestPath());
const out = flag("out", process.env.LAB_JEV_RECORDS ?? source.replace("retest.jsonl", "jev.jsonl"));
const real = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
if (real(source) === real(out)) {
  console.error("エラー: 保存先が入力と同じファイルです（--out を分けてください）。旧記録を汚染しません。");
  process.exit(2);
}
const limit = Math.max(1, Math.min(20, number("limit", 4)));
const caseIds = flag("cases", "").split(",").map(value => value.trim()).filter(Boolean);
const useJev = args.get("no-jev") !== true;
const baseUrl = process.env.LAB_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const model = flag("model", process.env.LAB_MODEL ?? "glm-5.3-flash");
const timeoutMs = number("timeout-ms", 60_000);
const plan = jevPlan();
// 現行校閲は接続先が固定のOpenCodeProvider。表示値と実送信先が違う場合はAPI実行前に止める。
const OPENCODE_ENDPOINT = "https://opencode.ai/zen/go/v1";
const endpointMismatch = baseUrl !== OPENCODE_ENDPOINT;
const { candidates, dropped } = await candidatesFromRecords(retestRecords(source), caseIds);
const picked = candidates.slice(0, limit);

console.log([
  "== D条件（同一候補への校閲比較）の実行予定 ==",
  "候補の元: " + source + "（保存済みの再試験記録。回答の再生成はしない）",
  "候補: " + String(candidates.length) + "件（内容hashで重複を除去。今回 " + String(picked.length) + "件、上限 " + String(limit) + "件）",
  "現行校閲: モデル " + model + " / 送信先 " + baseUrl + "（構造化候補を渡す）",
  "JEV: 送信先 " + plan.endpoint + " / モデル " + plan.model + " / 判定項目 " + plan.questions.join(",") + (useJev ? "" : "（--no-jev）"),
  "呼び出し上限: 現行校閲 最大" + String(picked.length) + "回 / JEV " + (useJev ? "最大" + String(picked.length) + "回" : "0回"),
  "保存先: " + out,
  "鍵: LAB_API_KEY " + (process.env.LAB_API_KEY ? "あり" : "未設定") + " / TYPESAFE_API_KEY " + (process.env.TYPESAFE_API_KEY ? "あり" : "未設定"),
  endpointMismatch ? "警告: 表示の接続先 " + baseUrl + " は現行校閲の実体 " + OPENCODE_ENDPOINT + " と異なるため、APIは実行しません。" : ""
].join(String.fromCharCode(10)));
if (dropped.length) console.log("取り出せなかった記録: " + String(dropped.length) + "件（" + dropped.map(item => item.reason).join(",") + "）");
if (!picked.length) { console.log("比較できる候補がありません。"); process.exit(0); }

const needsCurrent = args.get("dry-run") !== true;
const apiKey = process.env.LAB_API_KEY ?? "";
const keyProblem = !apiKey ? "LAB_API_KEY_missing" : (useJev && !process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY_missing" : null);
const snapshot = await prepareSnapshotForRetest({ vectorChannel: false });
const definition = await (await import("./modeD.mts")).judgeDefinitionHash();
const commit = baseSha();
const repository = snapshot.repository as unknown as KnowledgeRepository;

// 段階B: 由来ごとの整合と根拠の確定、実入力hashでの統合。dry-runでも同じ確定処理を使う（モデルAPIは0回）。
const finalized = await finalizeCandidates({ candidates, snapshot, repository });
const runnable = finalized.candidates.slice(0, limit);
let skipped = 0, calls = 0, failures = 0;
for (const stopped of finalized.stopped) {
  skipped += 1;
  if (needsCurrent) appendRetestRecord(out, notRunRecord({ candidate: stopped.candidate, inputHash: null, snapshotHash: snapshot.hash, baseSha: commit,
    currentModel: model, currentEndpoint: baseUrl, reason: stopped.reason, definitionHash: definition }) as never);
  console.log(stopped.candidate.caseId + " " + stopped.candidate.kind + " 送信せずに終了: " + stopped.reason
    + " / 呼び出し: 現行校閲0回 / JEV0回");
}
const runner = async (candidate: FinalCandidate) => {
  const checked = candidate.items.length ? await assertPublicNow(repository, candidate.items) : { kept: [], dropped: [] };
  const reasons = keyProblem || endpointMismatch || checked.dropped.length
    ? [ ...(keyProblem ? [keyProblem] : []), ...(endpointMismatch ? ["endpoint_mismatch"] : []),
        ...checked.dropped.map(entry => "evidence_not_public:" + entry.id) ]
    : [];
  if (reasons.length) {
    skipped += 1;
    const record = notRunRecord({ candidate, snapshotHash: snapshot.hash, baseSha: commit, currentModel: model,
      currentEndpoint: baseUrl, reason: reasons.join(","), definitionHash: definition });
    if (needsCurrent) appendRetestRecord(out, record as never);
    console.log([candidate.caseId + " " + candidate.kind + "（元 " + candidate.sourceRunId.slice(0, 8) + "）",
      String.fromCharCode(10) + "  送信せずに終了: " + reasons.join(" / "),
      String.fromCharCode(10) + "  呼び出し: 現行校閲0回 / JEV0回"].join(""));
    return;
  }
  // 最初の送信の直前にも、確定した根拠の現行性を再照合する（空根拠の不足説明は除外しない）。
  if (checked.kept.length && !await repository.revalidate(toEvidence(checked.kept))) {
    if (needsCurrent) appendRetestRecord(out, notRunRecord({ candidate, inputHash: candidate.inputHash, snapshotHash: snapshot.hash,
      baseSha: commit, currentModel: model, currentEndpoint: baseUrl, reason: "evidence_changed_before_send", definitionHash: definition }) as never);
    console.log(candidate.caseId + " " + candidate.kind + " 送信せずに終了: evidence_changed_before_send");
    return;
  }
  if (args.get("dry-run") === true) {
    console.log([candidate.caseId + " " + candidate.kind + "（元 " + candidate.sourceRunId.slice(0, 8) + "）",
      String.fromCharCode(10) + "  候補: " + textOfPayload(candidate.payload).slice(0, 100).replace(String.fromCharCode(10), " "),
      String.fromCharCode(10) + "  送信する根拠: " + checked.kept.map(item => item.id + "(" + item.kind + ")").join(", ")].join(""));
    return;
  }
  const provider = new OpenCodeProvider(apiKey, model,
    process.env.LAB_OPENCODE_JSON_MODE === "object" ? "object" : "schema", process.env.LAB_SESSION ?? "ai-mendan-kun-lab");
  const record = await compareCandidate({ candidate, items: checked.kept, inputHash: candidate.inputHash, snapshotHash: snapshot.hash, baseSha: commit,
    currentModel: model, currentEndpoint: baseUrl, provider, timeoutMs, useJev });
  appendRetestRecord(out, record as never);
  calls += record.current.apiCalls + record.jev.apiCalls;
  const jevText = record.jev.executionStatus === "ok"
    ? Object.entries(record.jev.answers).map(([key, value]) => key + "=" + (value.probability === null ? "?" : value.probability.toFixed(2))).join(" ")
    : record.jev.executionStatus === "not_run" ? "not_run(" + String(record.jev.reason) + ")" : "judge_error(" + String(record.jev.errorKind) + ")";
  const currentText = record.current.executionStatus === "ok"
    ? (record.current.verdict === "accepted" ? "合格" : "却下(" + String(record.current.reason) + ")")
    : "実行エラー(" + String(record.current.errorKind) + ")";
  console.log([record.caseId + " " + record.candidateKind + "（元 " + record.sourceRunId.slice(0, 8) + "）",
    String.fromCharCode(10) + "  候補: " + textOfPayload(record.structuredCandidate).slice(0, 110).replace(String.fromCharCode(10), " "),
    String.fromCharCode(10) + "  現行校閲: " + currentText + " / " + String(record.current.latencyMs) + "ms / tokens "
      + String(record.current.inputTokens) + "/" + String(record.current.outputTokens),
    String.fromCharCode(10) + "  JEV: " + jevText + " / " + String(record.jev.latencyMs) + "ms（ヘッダー "
      + String(record.jev.responseHeadersMs) + "ms）/ tokens " + String(record.jev.inputTokens) + "/" + String(record.jev.outputTokens)
      + " / 返却モデル " + String(record.returnedModel),
    record.notes.length ? String.fromCharCode(10) + "  注意: " + record.notes.join(" ") : ""
  ].join(""));
  if (record.current.executionStatus === "error" || record.jev.executionStatus === "error") failures += 1;
};
await runComparisons({ candidates: runnable, limit: runnable.length, runner });
if (args.get("dry-run") === true) console.log("--dry-run のため送信しません（モデルAPI 0回）。");
else console.log("保存しました: " + out + "（呼び出し " + String(calls) + "回 / 送信せず終了 " + String(skipped) + "件 / 失敗 " + String(failures) + "件）");
process.exit(failures ? 1 : 0);
