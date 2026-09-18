import type { Bindings } from "../types.ts";
import { TypeSafeJev } from "../ai/jev.ts";
import { defaultJevSettings, type JevSettings } from "./jev-settings.ts";
import type { JevPipeline } from "./jev-pipeline.ts";

export function pipelineName(env: Bindings): "legacy" | "jev_v1" {
  const name = env.ANSWER_PIPELINE || "legacy";
  if (name !== "legacy" && name !== "jev_v1") throw new Error("invalid_answer_pipeline");
  return name;
}
// settingsを省略した場合は環境既定を使う。回答では、質問の開始時点で読んだ設定を渡す。
export function createJevPipeline(env: Bindings, settings?: JevSettings): JevPipeline | undefined {
  if (pipelineName(env) === "legacy") return undefined;
  // 現行のOpenCode GoとOpenAI互換の生成を利用する。対応しない設定へ暗黙に切り替えない。
  if (!["opencode", "openai"].includes(env.ANSWER_PROVIDER ?? "")) throw new Error("compact_provider_not_supported");
  const resolved = settings ?? defaultJevSettings(env);
  return { settings: resolved, judge: new TypeSafeJev(env.TYPESAFE_API_KEY ?? "", resolved.budgets.jevMs),
    timeoutMs: resolved.budgets.answerMs };
}
