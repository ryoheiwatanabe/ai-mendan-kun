// 実行記録（JSONL）。既定の保存先は公開対象外の .local 配下。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManualLabel, RunRecord } from "./types.mts";

const newline = String.fromCharCode(10);

export function defaultRecordsPath(): string {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  return root + ".local/conversation-lab/records.jsonl";
}

export function appendRecord(path: string, record: RunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + newline, "utf8");
}

export function readRecords(path: string): RunRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(newline)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RunRecord);
}

export function updateLabel(path: string, runId: string, label: ManualLabel): boolean {
  const records = readRecords(path);
  let updated = false;
  for (const record of records) {
    if (record.runId === runId) {
      record.label = label;
      updated = true;
    }
  }
  if (updated) writeFileSync(path, records.map(record => JSON.stringify(record) + newline).join(""), "utf8");
  return updated;
}

// 小標本のp95は不安定なので、値と件数を併記して扱う。欠測はnullのままにし、推定で埋めない。
export function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[index];
}

export interface Summary {
  total: number;
  ok: number;
  errors: Record<string, number>;
  answeredWithLimitationOnly: number;
  latency: { p50: number | null; p95: number | null; max: number | null };
  usage: { withUsage: number; meanInputTokens: number | null; meanOutputTokens: number | null };
  labeled: number;
  apiCalls: number;
}

export function summarize(records: RunRecord[]): Summary {
  const errors: Record<string, number> = {};
  const latency: number[] = [];
  const inputs: number[] = [];
  const outputs: number[] = [];
  let ok = 0, labeled = 0, apiCalls = 0, limitationOnly = 0;
  for (const record of records) {
    apiCalls += record.apiCalls;
    if (record.status === "ok") ok += 1;
    else errors[record.errorKind ?? "unknown"] = (errors[record.errorKind ?? "unknown"] ?? 0) + 1;
    if (record.status === "ok" && record.answer.trim().length === 0 && record.limitations.trim().length > 0) limitationOnly += 1;
    if (record.timing.totalMs > 0) latency.push(record.timing.totalMs);
    if (record.usage.inputTokens !== null) inputs.push(record.usage.inputTokens);
    if (record.usage.outputTokens !== null) outputs.push(record.usage.outputTokens);
    if (record.label) labeled += 1;
  }
  const sorted = [...latency].sort((a, b) => a - b);
  const mean = (values: number[]): number | null => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    total: records.length,
    ok,
    errors,
    answeredWithLimitationOnly: limitationOnly,
    latency: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.length ? sorted[sorted.length - 1] : null },
    usage: { withUsage: inputs.length, meanInputTokens: mean(inputs), meanOutputTokens: mean(outputs) },
    labeled,
    apiCalls
  };
}
