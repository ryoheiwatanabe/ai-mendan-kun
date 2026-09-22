import { test, expect } from "@playwright/test";

// 公開用資料の取り込み（#5）。未保存の編集で承認できないこと、最終確認が「保存済み下書きの対象」と一致することを、ブラウザ経由で確認する。
const draft = (overrides: Record<string, unknown> = {}) => ({ id: "d1", status: "draft", title: "仕事の価値観",
  publicText: "候補の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values", kept: [], omitted: [], questions: [],
  model: "glm-5.3-flash", promptVersion: "public-knowledge-20260919-1", approvedRevisionId: null,
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", version: 1, approvalHash: "hash-v1",
  target: { kind: "new" }, ...overrides });
const revA = "rev_" + "a".repeat(32), revB = "rev_" + "b".repeat(32);
const documents = [{ documentId: "doc_a", revisionId: revA, title: "旧カードA", facts: 0, chunks: 1 },
  { documentId: "doc_b", revisionId: revB, title: "旧カードB", facts: 2, chunks: 2 }];
const listing = { sources: [], drafts: [draft()], publicDocuments: documents,
  destination: { label: "本番と同じD1データベース・Vectorize索引", rawStorage: "原文はCloudflareの管理専用テーブルへ保存されます。" },
  providerReady: true, provider: { label: "OpenCode Go", model: "glm-5.3-flash", promptVersion: "public-knowledge-20260919-1" } };
const consent = /原文をCloudflareの管理専用テーブルへ保存/;
const autoConsent = /この原文を公開対象として取り込み/;
const confirmCheck = /上の見出し・公開本文・検索語で登録します/;
const factCheck = /引き継がれないことを了解しました/;

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
  await page.getByRole("checkbox", { name: consent }).check();
  await page.getByLabel("文書名（公開カードの見出し）").fill("仕事の価値観");
  await page.locator("#intake-source").fill("架空の原文マーカー MKR-1。面白さと裁量を重視している。");
  await page.getByRole("button", { name: "公開用候補を作る" }).click();
  await expect(page.locator(".intake-public")).toHaveValue("候補の公開文です。");
  await page.locator(".intake-public").fill("編集後の公開文です。");
  await expect(page.getByText("編集中の内容はまだ保存されていません")).toBeVisible();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toHaveCount(0);
  await page.getByRole("button", { name: "下書き保存" }).click();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toBeVisible();
  await page.getByLabel("検索語（カンマ区切り・1〜12件）").fill("仕事選びの軸, 裁量");
  await expect(page.getByRole("button", { name: "承認して検索登録" })).toHaveCount(0);
  await page.getByRole("button", { name: "下書き保存" }).click();
  await expect(page.getByRole("heading", { name: "3. 公開内容の最終確認" })).toBeVisible();
  await page.getByRole("checkbox", { name: confirmCheck }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  expect(approveBodies.length).toBe(1);
  expect(approveBodies[0].version).toBe(2);
  expect(approveBodies[0].approvalHash).toBe("hash-v2");
  expect(approveBodies[0].expectedTarget).toEqual({ kind: "new" });
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
  await page.getByRole("checkbox", { name: confirmCheck }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  await expect(page.locator("p.error-message")).toHaveText("別の画面で保存されたため、内容が変わっています。読み直してから、もう一度確認してください。");
});

test("最終確認の対象は、作成フォームではなく保存済み下書きの対象に従う", async ({ page }) => {
  const approveBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: { ...listing,
      drafts: [draft({ target: { kind: "replace", documentId: "doc_a", revisionId: revA, title: "旧カードA", facts: 0, chunks: 1 } })] } });
    if (body.action === "approve") { approveBodies.push(body as Record<string, unknown>);
      return route.fulfill({ json: { draft: draft({ status: "approved",
        target: { kind: "replace", documentId: "doc_a", revisionId: revA, title: "旧カードA", facts: 0, chunks: 1 } }),
        published: { title: "仕事の価値観", publicText: "候補の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values" } } }); }
    return route.fulfill({ json: { draft: draft() } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await page.getByRole("button", { name: "開く" }).first().click();
  await expect(page.getByText(/置換（対象: 旧カードA/)).toBeVisible();
  await page.getByLabel("置換する既存の公開版（任意）").selectOption(revB);
  await expect(page.getByText(/置換（対象: 旧カードA/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: factCheck })).toHaveCount(0);
  await page.getByRole("checkbox", { name: confirmCheck }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  expect(approveBodies[0]?.expectedTarget).toEqual({ kind: "replace", revisionId: revA });
});

test("新規の下書きでは、フォームで選んだ置換先のFact了解を出さない", async ({ page }) => {
  const approveBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: listing });
    if (body.action === "approve") { approveBodies.push(body as Record<string, unknown>);
      return route.fulfill({ json: { draft: draft({ status: "approved" }), published: { title: "仕事の価値観",
        publicText: "候補の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values" } } }); }
    return route.fulfill({ json: { draft: draft() } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await page.getByRole("button", { name: "開く" }).first().click();
  await expect(page.getByText("新規カードとして追加")).toBeVisible();
  await page.getByLabel("置換する既存の公開版（任意）").selectOption(revA);
  await expect(page.getByText("新規カードとして追加")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: factCheck })).toHaveCount(0);
  await page.getByRole("checkbox", { name: confirmCheck }).check();
  await page.getByRole("button", { name: "承認して検索登録" }).click();
  expect(approveBodies[0]?.expectedTarget).toEqual({ kind: "new" });
});

// #6: 公開対象として明示した原文は、言い換えごとの承認を挟まず自動リライトして登録する。
test("公開対象として明示すると、言い換えごとの承認なしで自動リライトして登録する", async ({ page }) => {
  const autoBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/intake", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? JSON.parse(request.postData() ?? "{}") : null;
    if (!body) return route.fulfill({ json: { ...listing, exclusionRevision: "1-abcdef12",
      autoPolicyVersion: "intake-auto-interview-rephrase-v1" } });
    if (body.action === "auto") {
      autoBodies.push(body as Record<string, unknown>);
      return route.fulfill({ json: { draft: draft({ status: "approved", autoAdopted: true,
        autoPolicyVersion: "intake-auto-interview-rephrase-v1", approvedRevisionId: revA }),
        autoAdopted: true, held: false, revisionId: revA,
        published: { title: "仕事の価値観", publicText: "自動リライト後の公開文です。", aliases: ["仕事選びの軸"], topic: "work_values" } } });
    }
    return route.fulfill({ json: { draft: draft() } });
  });
  await page.goto("/admin/intake");
  await page.locator("#intake-token").fill("x".repeat(48));
  await page.getByRole("button", { name: "読み込む" }).click();
  await expect(page.getByText(/非表示の設定版: 1-abcdef12/)).toBeVisible();
  await page.getByRole("checkbox", { name: consent }).check();
  await page.getByRole("checkbox", { name: autoConsent }).check();
  await page.getByLabel("文書名（公開カードの見出し）").fill("仕事の価値観");
  await page.locator("#intake-source").fill("架空の原文マーカー MKR-1。面白さと裁量を重視している。");
  await page.getByRole("button", { name: "自動リライトで取り込む" }).click();
  expect(autoBodies.length).toBe(1);
  expect(autoBodies[0].publicTarget).toBe(true);
  expect(autoBodies[0].acknowledgeStorage).toBe(true);
  await expect(page.getByText(/自動適用し、検索へ登録しました/)).toBeVisible();
});
