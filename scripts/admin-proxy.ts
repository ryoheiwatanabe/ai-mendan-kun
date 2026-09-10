import { adminErrorCode } from "../lib/security/admin-error.ts";
type Admin = { prepare(value: unknown): Promise<any>; approve(value: unknown, hash: string): Promise<any>; revoke(id: string): Promise<any>; checkProvider(): Promise<any> };
export default {
  async fetch(request: Request, env: { KNOWLEDGE_ADMIN: Admin }) {
    // このブリッジはlocalhost専用。公開デプロイ・ブラウザからの呼び出しを拒否する。
    if (new URL(request.url).hostname !== "127.0.0.1" || request.headers.has("origin") || request.method !== "POST"
      || request.headers.get("content-type") !== "application/json") return new Response("Forbidden", { status: 403 });
    const body = await request.text();
    if (body.length > 70_000) return new Response("Too large", { status: 413 });
    try {
      const input = JSON.parse(body);
      const result = input.action === "stage" ? await env.KNOWLEDGE_ADMIN.prepare(input.bundle)
        : input.action === "approve" ? await env.KNOWLEDGE_ADMIN.approve(input.bundle, input.hash)
        : input.action === "revoke" ? await env.KNOWLEDGE_ADMIN.revoke(input.revisionId)
        : input.action === "check-provider" ? await env.KNOWLEDGE_ADMIN.checkProvider() : null;
      if (result?.status === "failed") return Response.json({ error: `管理処理を停止しました（${result.code}）。` }, { status: 409 });
      return Response.json({ result }, { status: result ? 200 : 400, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      // 下位プロバイダの応答や文書本文をターミナルへ流さない。
      return Response.json({ error: `管理処理を停止しました（${adminErrorCode(error)}）。` }, { status: 409 });
    }
  }
};
