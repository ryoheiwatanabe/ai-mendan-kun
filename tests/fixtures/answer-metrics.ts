import type { AnswerMetrics } from "../../lib/answer/metrics.ts";

export const answerMetricsFixture: AnswerMetrics = {
  jev: { calls: 5, failed: 1, milliseconds: 2345,
    byPurpose: { scope: 1, screening: 1, routes: 1, verification: 2, input_normalization: 0, intake_review: 0 },
    inputTokens: 1234, outputTokens: 56, usageCalls: 3 },
  generation: { calls: 2, repairs: 1, completed: 2, milliseconds: 1820, inputTokens: null, outputTokens: null, usageCalls: 0 },
  retrieval: { candidates: 12, adopted: 5, milliseconds: 140 }
};
