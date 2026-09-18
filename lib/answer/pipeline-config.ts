import type { Bindings } from "../types.ts";
import { TypeSafeJev, jevThresholds } from "../ai/jev.ts";
import type { JevPipeline } from "./jev-pipeline.ts";

export function pipelineName(env: Bindings): "legacy" | "jev_v1" {
  const name = env.ANSWER_PIPELINE || "legacy";
  if (name !== "legacy" && name !== "jev_v1") throw new Error("invalid_answer_pipeline");
  return name;
}
const milliseconds = (value: string | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error("invalid_answer_timeout");
  return parsed;
};
export function createJevPipeline(env: Bindings): JevPipeline | undefined {
  if (pipelineName(env) === "legacy") return undefined;
  // 現行のOpenCode GoとOpenAI互換の生成を利用する。対応しない設定へ暗黙に切り替えない。
  if (!["opencode", "openai"].includes(env.ANSWER_PROVIDER ?? "")) throw new Error("compact_provider_not_supported");
  return { judge: new TypeSafeJev(env.TYPESAFE_API_KEY ?? "", jevThresholds(env.JEV_THRESHOLDS_JSON),
    milliseconds(env.JEV_TIMEOUT_MS, 4000, 500, 15000)), timeoutMs: milliseconds(env.ANSWER_TIMEOUT_MS, 25000, 3000, 60000) };
}
