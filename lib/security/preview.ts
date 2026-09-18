import type { Bindings } from "../types.ts";

// 本人用の版だけ有効にする。未設定の鍵で保護が外れないようにする。
export function previewAllowed(request: Request, env: Pick<Bindings, "PREVIEW_ONLY" | "PREVIEW_ACCESS_TOKEN">): boolean {
  if (env.PREVIEW_ONLY === undefined || env.PREVIEW_ONLY === "false") return true;
  if (env.PREVIEW_ONLY !== "true" || !env.PREVIEW_ACCESS_TOKEN || env.PREVIEW_ACCESS_TOKEN.length < 32) return false;
  const supplied = request.headers.get("x-mendan-preview") ?? "";
  if (supplied.length !== env.PREVIEW_ACCESS_TOKEN.length) return false;
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i++) mismatch |= supplied.charCodeAt(i) ^ env.PREVIEW_ACCESS_TOKEN.charCodeAt(i);
  return mismatch === 0;
}
