import { test, expect } from "@playwright/test";

// 公開用資料の取り込み（#5）。未保存の編集で承認できないことを、ブラウザ経由で確認する。
const draft = (overrides: Record<string, unknown> = {}) => ({ id: "d1", status: "draft", title: "仕事の価値観",
  publicText: "候補の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values", kept: [], omitted: [], questions: [],
  model: "glm-5.3-flash", promptVersion: "public-knowledge-20260919-1", approvedRevisionId: null,
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", version: 1, approvalHash: "hash-v1", ...overrides });
const listing = { sources: [], drafts: [draft()], publicDocuments: [],
  destination: { label: "本番と同じD1データベース・Vectorize索引", rawStorage: "原文はCloudflareの管理専用テーブルへ保存されます。" },
  providerReady: true, provider: { label: "OpenCode Go", model: "glm-5.3-flash", promptVersion: "public-knowledge-20260919-1" } };

test("未保存の編集では承認できず、保存した内容だけを承認する", async ({ page }) => {
  const approveBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: listing });
    if (body.action === "prepare") return route.fulfill({ json: { draft: draft() } });
    if (body.action === "save") return route.fulfill({ json: { draft: draft({ publicText: body.publicText, aliases: body.aliases, version: 2, approvalHash: "hash-v2" }) } });
    if (body.action === "approve") { approveBodies.push(body as Record<string, unknown>);
      return route.fulfill({ json: { draft: draft({ status: "approved", version: 2, approvalHash: "hash-v2" }),
        published: { title: "仕事の価値観", publicText: "編集後の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values" } } }); }
    return route.fulfill({ status: 400, json: { error: { message: "unexpected" } } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await page.getByRole("checkbox", { name: /原文をCloudflareの管理専用テーブルへ保存/ }).check();
  await page.getByLabel("文書名（公開カードの見出し）").fill("仕事の価値観");
  await page.locator("#intake-source").fill("架空の原文マーカー MKR-1。面白さと裁量を重視している。");
  await page.getByRole("button", { name: "公開用候補を作る" }).click();
  await expect(page.locator(".intake-public")).toHaveValue("候補の公開文です。");
  // 本文を編集する。まだ保存していないので承認できない。
  await page.locator(".intake-public").fill("編集後の公開文です。");
  await expect(page.getByText("編集中の内容はまだ保存されていません")).toBeVisible();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toHaveCount(0);
  // 保存すると、承認対象の確認が出る。検索語の編集でも同じ。
  await page.getByRole("button", { name: "下書き保存" }).click();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toBeVisible();
  await page.getByLabel("検索語（カンマ区切り・1〜12件）").fill("仕事選びの軸, 裁量");
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toHaveCount(0);
  await page.getByRole("button", { name: "下書き保存" }).click();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toBeVisible();
  await page.getByRole("checkbox", { name: /上の見出し・公開本文・検索語で登録します/ }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  expect(approveBodies.length).toBe(1);
  expect(approveBodies[0].version).toBe(2);
  expect(approveBodies[0].approvalHash).toBe("hash-v2");
  await expect(page.getByText("登録した内容: 仕事の価値観")).toBeVisible();
});

test("別タブの保存で版が変わっていたら、承認しない", async ({ page }) => {
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: listing });
    if (body.action === "approve") return route.fulfill({ status: 409,
      json: { error: { code: "intake_stale_version", message: "別の画面で保存されたため、内容が変わっています。読み直してから、もう一度確認してください。" } } });
    return route.fulfill({ json: { draft: draft() } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await page.getByRole("button", { name: "開く" }).first().click();
  await page.getByRole("checkbox", { name: /上の見出し・公開本文・検索語で登録します/ }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  await expect(page.locator("p.error-message")).toHaveText("別の画面で保存されたため、内容が変わっています。読み直してから、もう一度確認してください。");
});

test("Factを持つ資料の置換は、引き継がないことの了解を取る", async ({ page }) => {
  const target = { documentId: "doc_abc", revisionId: "rev_" + "a".repeat(32), title: "旧カード", facts: 2, chunks: 1 };
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: { ...listing, publicDocuments: [target] } });
    return route.fulfill({ json: { draft: draft() } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await page.getByRole("button", { name: "開く" }).first().click();
  await page.getByLabel("置換する既存の公開版（任意）").selectOption(target.revisionId);
  await expect(page.getByText("Fact 2件は新しいカードへ引き継がれません")).toBeVisible();
  await page.getByRole("checkbox", { name: /上の見出し・公開本文・検索語で登録します/ }).check();
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /引き継がれないことを了解しました/ }).check();
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toBeEnabled();
});
