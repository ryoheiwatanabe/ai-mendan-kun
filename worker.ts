/// <reference types="@cloudflare/workers-types" />
// OpenNextの生成物はbuild:worker時に生成される。
// @ts-ignore generated file
import handler from "./.open-next/worker.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "./lib/types.ts";
import { createEmbeddingProvider, embeddingSignature, providerNames } from "./lib/ai/providers.ts";
import { assertEmbeddingSignature } from "./lib/knowledge/index-config.ts";
import { adminErrorCode } from "./lib/security/admin-error.ts";
import { GeminiProvider } from "./lib/ai/gemini.ts";
import { approveImport, prepareImport, revokeRevision, stageImport, type WritableVectorIndex } from "./lib/knowledge/import.ts";

export default { fetch: handler.fetch };

// HTTPルートを持たない管理RPC。Cloudflareアカウント内のservice bindingからのみ呼ぶ。
export class KnowledgeAdmin extends WorkerEntrypoint<Bindings & { VECTORIZE: WritableVectorIndex }> {
  async prepare(value: unknown) {
    const prepared = await this.checked(value);
    return stageImport(this.env.DB, prepared);
  }
  async approve(value: unknown, approvalHash: string) {
    try {
    const prepared = await this.checked(value);
    if (approvalHash !== prepared.hash) throw new Error("承認ハッシュが一致しません。");
    const embedding = createEmbeddingProvider(this.env);
    await assertEmbeddingSignature(this.env.DB, prepared.bundle.ownerId, embeddingSignature(this.env), true);
    return await approveImport({ db: this.env.DB, vector: this.env.VECTORIZE, embedding, prepared, approvalHash, signal: AbortSignal.timeout(120_000) });
    } catch (error) { return { status: "failed", code: adminErrorCode(error) }; }
  }
  async checkProvider() {
    // この補助診断はGeminiのモデル一覧API専用。Claude等のモデル名をGoogleへ送らない。
    try {
      const selected = providerNames(this.env);
      if (selected.answer !== "gemini" || selected.embedding !== "gemini") return { status: "unsupported", code: "model_check_gemini_only" };
    } catch { return { status: "failed", code: "provider_not_configured" }; }
    if (!this.env.GEMINI_API_KEY) return { status: "failed", code: "provider_not_configured" };
    if (!/^AIza[A-Za-z0-9_-]{20,100}$/.test(this.env.GEMINI_API_KEY)) return { status: "failed", code: "invalid_api_key_format" };
    const provider = new GeminiProvider(this.env.GEMINI_API_KEY, this.env.ANSWER_MODEL, this.env.EMBEDDING_MODEL);
    try { return { status: "checked", models: await provider.checkModels(AbortSignal.timeout(20_000)) }; }
    catch (error) { return { status: "failed", code: adminErrorCode(error) }; }
  }
  async revoke(revisionId: string) {
    return revokeRevision(this.env.DB, this.env.VECTORIZE, this.env.OWNER_ID || "default", revisionId);
  }
  private async checked(value: unknown) {
    const prepared = await prepareImport(value);
    if (prepared.bundle.ownerId !== (this.env.OWNER_ID || "default")) throw new Error("ownerIdがデプロイ設定と異なります。");
    return prepared;
  }
}
