import type { Bindings } from "../types.ts";
import { constantTimeEqual } from "./secret-compare.ts";

export const ADMIN_HEADER = "x-mendan-admin";

// 管理操作は本人だけが行う。未設定・短すぎる鍵では必ず拒否し、閲覧用の試用鍵とは別に扱う。
export function adminAllowed(request: Request, env: Pick<Bindings, "ADMIN_TOKEN">): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected || expected.length < 32) return false;
  return constantTimeEqual(request.headers.get(ADMIN_HEADER) ?? "", expected);
}
