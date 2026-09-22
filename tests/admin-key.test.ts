import test from "node:test";
import assert from "node:assert/strict";
import { clearStoredAdminKey, readStoredAdminKey, storeAdminKey, type AdminKeyStorage } from "../lib/admin-key.ts";

const memoryStorage = (): AdminKeyStorage & { size(): number } => {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); }, size: () => map.size };
};
const adminKey = "k".repeat(48);

test("記憶を選んだときだけ管理鍵を残し、外すと消す", () => {
  const storage = memoryStorage();
  assert.equal(readStoredAdminKey(storage), "");
  storeAdminKey(adminKey, storage);
  assert.equal(readStoredAdminKey(storage), adminKey);
  assert.equal(storage.size(), 1);
  // 上書き保存しても増えない。
  storeAdminKey("z".repeat(40), storage);
  assert.equal(storage.size(), 1);
  assert.equal(readStoredAdminKey(storage), "z".repeat(40));
  clearStoredAdminKey(storage);
  assert.equal(readStoredAdminKey(storage), "");
  assert.equal(storage.size(), 0);
});

test("短すぎる値は残さず、保存できない環境でも落とさない", () => {
  const storage = memoryStorage();
  storeAdminKey("292929", storage);
  storeAdminKey("", storage);
  assert.equal(storage.size(), 0);
  const broken: AdminKeyStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => storeAdminKey(adminKey, broken));
  assert.equal(readStoredAdminKey(broken), "");
  assert.doesNotThrow(() => clearStoredAdminKey(broken));
  // 保存領域そのものが無い環境（サーバー側・プライベートモード）。
  assert.equal(readStoredAdminKey(null), "");
  assert.doesNotThrow(() => storeAdminKey(adminKey, null));
  assert.doesNotThrow(() => clearStoredAdminKey(null));
});
