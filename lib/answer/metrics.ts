import type { Diagnostic } from "../types.ts";

export type JevPurpose = NonNullable<Diagnostic["purpose"]>;
type Usage = { inputTokens: number | null; outputTokens: number | null; usageCalls: number };
export type AnswerMetrics = {
  jev: Usage & { calls: number; failed: number; milliseconds: number; byPurpose: Record<JevPurpose, number> };
  generation: Usage & { calls: number; repairs: number; completed: number; milliseconds: number };
  retrieval: { candidates: number | null; adopted: number | null; milliseconds: number | null };
};
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const emptyUsage = (): Usage => ({ inputTokens: null, outputTokens: null, usageCalls: 0 });

// 質問ごとの集計。許可した数値だけを写し、トレースの本文・ID・自由文を公開しない。
export function createAnswerMetrics() {
  const value: AnswerMetrics = {
    jev: { ...emptyUsage(), calls: 0, failed: 0, milliseconds: 0, byPurpose: { scope: 0, screening: 0, routes: 0, verification: 0 } },
    generation: { ...emptyUsage(), calls: 0, repairs: 0, completed: 0, milliseconds: 0 },
    retrieval: { candidates: null, adopted: null, milliseconds: null }
  };
  const usage = (target: Usage, event: Diagnostic) => {
    if (!nonnegative(event.inputTokens) || !nonnegative(event.outputTokens)) return;
    target.inputTokens = (target.inputTokens ?? 0) + event.inputTokens;
    target.outputTokens = (target.outputTokens ?? 0) + event.outputTokens;
    target.usageCalls++;
  };
  return {
    record(event: Diagnostic) {
      switch (event.code) {
        // countは判定項目数にも使われるため、通信試行の終了1件を1回と数える。
        case "jev_request_complete":
        case "jev_request_failed":
          value.jev.calls++;
          if (event.purpose && Object.hasOwn(value.jev.byPurpose, event.purpose)) value.jev.byPurpose[event.purpose]++;
          if (nonnegative(event.latencyMs)) value.jev.milliseconds += event.latencyMs;
          if (event.code === "jev_request_failed") value.jev.failed++;
          usage(value.jev, event);
          break;
        case "generation_attempt": value.generation.calls++; break;
        case "repair_attempted": value.generation.repairs++; break;
        case "generation_complete":
        case "repair_complete":
          value.generation.completed++;
          if (nonnegative(event.latencyMs)) value.generation.milliseconds += event.latencyMs;
          usage(value.generation, event);
          break;
        case "retrieval_complete":
          if (nonnegative(event.latencyMs)) value.retrieval.milliseconds = event.latencyMs;
          break;
        case "candidates_retrieved":
          if (nonnegative(event.count)) value.retrieval.candidates = event.count;
          break;
        case "candidates_adopted":
          if (nonnegative(event.count)) value.retrieval.adopted = event.count;
      }
    },
    snapshot(): AnswerMetrics { return structuredClone(value); }
  };
}
