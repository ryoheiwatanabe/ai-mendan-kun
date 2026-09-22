import type { Bindings } from "../types.ts";
import { constantTimeEqual } from "./secret-compare.ts";

// 本人用の版だけ有効にする。未設定の鍵で保護が外れないようにする。
export function previewAllowed(request: Request, env: Pick<Bindings, "PREVIEW_ONLY" | "PREVIEW_ACCESS_TOKEN">): boolean {
  const access = previewGrant(request, env);
  return access.kind === "open" || access.kind === "allowed";
}

// 外から試すときは、ブラウザ標準のBasic認証でパスワードとして鍵を受け取る。
export const PREVIEW_REALM = "AI面談くん 試用版";
export type PreviewAccess = { kind: "open" | "allowed" | "grant" | "denied" };
export function previewGrant(request: Request, env: Pick<Bindings, "PREVIEW_ONLY" | "PREVIEW_ACCESS_TOKEN">): PreviewAccess {
  if (env.PREVIEW_ONLY === undefined || env.PREVIEW_ONLY === "false") return { kind: "open" };
  const expected = env.PREVIEW_ACCESS_TOKEN;
  if (env.PREVIEW_ONLY !== "true" || !expected || expected.length < 32) return { kind: "denied" };
  if (constantTimeEqual(request.headers.get("x-mendan-preview") ?? "", expected)) return { kind: "allowed" };
  // スマホなど鍵をヘッダーで送れない場合は、ブラウザ標準のBasic認証を使う（ユーザー名は任意、パスワードが鍵）。
  if (constantTimeEqual(basicPassword(request.headers.get("authorization")) ?? "", expected)) return { kind: "allowed" };
  return { kind: "denied" };
}

function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const separator = decoded.indexOf(":");
    return separator < 0 ? decoded : decoded.slice(separator + 1);
  } catch {
    return null;
  }
}
