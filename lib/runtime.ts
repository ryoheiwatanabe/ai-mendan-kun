import type { Bindings } from "./types.ts";
import { PublicError } from "./security/request.ts";
import { createAnswerProvider, createEmbeddingProvider, processorNames } from "./ai/providers.ts";

async function loadBindings(): Promise<Bindings> {
  // 本番はCloudflare bindingsを使用。未設定のローカル画面では準備中を返す。
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  let env: Bindings;
  try { env = (await getCloudflareContext({ async: true })).env as unknown as Bindings; }
  catch { throw new PublicError("NOT_CONFIGURED", 503, "ただいま面談の準備中です。少し時間をおいてからお試しください。"); }
  return env;
}

export async function getBindings(): Promise<Bindings> {
  const env = await loadBindings();
  try {
    if (!env.DB || !env.VECTORIZE) throw new Error("missing_binding");
    createAnswerProvider(env); createEmbeddingProvider(env);
  } catch { throw new PublicError("NOT_CONFIGURED", 503, "ただいま面談の準備中です。少し時間をおいてからお試しください。"); }
  return env;
}

export async function getProcessorNames(): Promise<string> {
  let env: Bindings;
  try { env = await loadBindings(); } catch { return "GoogleのGemini API"; }
  try {
    return processorNames(env);
  } catch { return "設定された外部AI API"; }
}
