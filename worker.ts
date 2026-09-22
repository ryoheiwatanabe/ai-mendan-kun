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
import { reembedActiveRevisions } from "./lib/knowledge/reembed.ts";
import { PREVIEW_REALM, previewGrant } from "./lib/security/preview.ts";
import { assertAllowedContent, getContentExclusions } from "./lib/security/content-exclusions.ts";

export default { async fetch(request: Request, env: Bindings, context: ExecutionContext) {
  const access = previewGrant(request, env);
  // 鍵が無いときは、ブラウザがパスワードを聞けるようにBasic認証で応答する。
  if (access.kind === "denied") return new Response("Protected preview", {
    status: 401, headers: { "WWW-Authenticate": `Basic realm="${PREVIEW_REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  // run_worker_firstの保護付き版では、認証後に静的ファイルも明示的に返す。
  if (env.PREVIEW_ONLY === "true" && env.ASSETS && ["GET", "HEAD"].includes(request.method)) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    await asset.body?.cancel();
  }
  return handler.fetch(request, env, context);
} };

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
    return await approveImport({ db: this.env.DB, vector: this.env.VECTORIZE, embedding, prepared, approvalHash,
      signal: AbortSignal.timeout(120_000), policy: getContentExclusions(this.env) });
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
  // 埋め込みモデルの切替時だけ使う。承認済み現行版を同じidで作り直し、最後に署名を切り替える。
  async reembed() {
    try {
      const embedding = createEmbeddingProvider(this.env);
      return await reembedActiveRevisions({ db: this.env.DB, vector: this.env.VECTORIZE, embedding,
        ownerId: this.env.OWNER_ID || "default", signature: embeddingSignature(this.env), signal: AbortSignal.timeout(120_000),
        exclusions: getContentExclusions(this.env) });
    } catch (error) { return { status: "failed", code: adminErrorCode(error) }; }
  }
  private async checked(value: unknown) {
    assertAllowedContent(value, getContentExclusions(this.env));
    const prepared = await prepareImport(value, { policy: getContentExclusions(this.env) });
    if (prepared.bundle.ownerId !== (this.env.OWNER_ID || "default")) throw new Error("ownerIdがデプロイ設定と異なります。");
    return prepared;
  }
}
