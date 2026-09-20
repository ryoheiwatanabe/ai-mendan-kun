import { test, expect } from "@playwright/test";

// 管理用の鍵を、本人が選んだときにこの端末へ残し、次に開いたとき自動で入ることを確認する。
const listing = { sources: [], drafts: [], publicDocuments: [],
  destination: { label: "本番と同じD1データベース・Vectorize索引", rawStorage: "原文はCloudflareの管理専用テーブルへ保存されます。" },
  providerReady: true, provider: { label: "OpenCode Go", model: "glm-5.3-flash", promptVersion: "public-knowledge-20260919-1" } };
const adminKey = "292929-mendan-admin-2026-09-20-tokyo";

test("管理用の鍵は、記憶を選んだときだけ残り、次に開いたとき自動で入る", async ({ page }) => {
  await page.route("**/api/admin/intake", route => route.fulfill({ json: listing }));
  await page.goto("/admin/intake");
  const input = page.locator("#intake-token");
  const remember = page.getByRole("checkbox", { name: /この端末に記憶する/ });
  const load = page.getByRole("button", { name: "読み込む" });
  await expect(remember).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await input.fill(adminKey);
  await load.click();
  await expect(page.getByText("管理データを読み込みました。")).toBeVisible();
  // 記憶を選ぶまでは、この端末に何も残さない。
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await remember.check();
  await load.click();
  await expect(page.getByText("管理データを読み込みました。")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mendan.admin.key"))).toBe(adminKey);
  // 開き直すと、鍵は入ったままで、そのまま読み込める。
  await page.reload();
  await expect(input).toHaveValue(adminKey);
  await expect(remember).toBeChecked();
  await expect(load).toBeEnabled();
  await expect(page.getByText("管理データを読み込みました。")).toBeVisible();
  // 外すと、この端末から消えて、次に開いたときは空のまま。
  await remember.uncheck();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(remember).not.toBeChecked();
});
