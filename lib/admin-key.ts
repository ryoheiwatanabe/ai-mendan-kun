// 管理用の鍵を、本人が選んだときだけブラウザーへ残す。サーバー側には保存しない。
// 端末を共用するときや、保存したくないときはチェックを外すと消える。
export const adminKeyStorageKey = "mendan.admin.key";

export type AdminKeyStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// 保存領域が無い・使えない環境（プライベートモードなど）でも落とさない。
function browserStorage(): AdminKeyStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readStoredAdminKey(storage: AdminKeyStorage | null = browserStorage()): string {
  try { return storage?.getItem(adminKeyStorageKey) ?? ""; } catch { return ""; }
}

export function storeAdminKey(value: string, storage: AdminKeyStorage | null = browserStorage()): void {
  // 鍵として使えない短い値や空文字は残さない（サーバー側の下限と同じ32文字）。
  if (value.length < 32) return;
  try { storage?.setItem(adminKeyStorageKey, value); } catch { /* 保存できなくても、入力した鍵で続けられる。 */ }
}

export function clearStoredAdminKey(storage: AdminKeyStorage | null = browserStorage()): void {
  try { storage?.removeItem(adminKeyStorageKey); } catch { /* 何もしない。 */ }
}
