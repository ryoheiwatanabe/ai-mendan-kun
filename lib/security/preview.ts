import type { Bindings } from "../types.ts";
import { constantTimeEqual } from "./secret-compare.ts";

// 本人用の版だけ有効にする。未設定の鍵で保護が外れないようにする。
export function previewAllowed(request: Request, env: Pick<Bindings, "PREVIEW_ONLY" | "PREVIEW_ACCESS_TOKEN">): boolean {
  if (env.PREVIEW_ONLY === undefined || env.PREVIEW_ONLY === "false") return true;
  if (env.PREVIEW_ONLY !== "true" || !env.PREVIEW_ACCESS_TOKEN || env.PREVIEW_ACCESS_TOKEN.length < 32) return false;
  const supplied = request.headers.get("x-mendan-preview") ?? "";
  return constantTimeEqual(supplied, env.PREVIEW_ACCESS_TOKEN);
}
