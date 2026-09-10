import { test, expect } from "@playwright/test";

for (const width of [320, 375, 414, 768, 1440]) {
  test(`幅${width}pxで入口と質問欄が横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "会う前に、 少し話そう。" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.getByRole("button", { name: "AI面談をはじめる" }).click();
    await expect(page.getByRole("textbox", { name: "質問を入力" })).toBeFocused();
    await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
  });
}

test("接続失敗では入力を復元し、会話終了でメモリを消す", async ({ page }) => {
  let calls = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/chat", async route => {
    if (++calls === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "ただいま準備中です。" } }) });
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ contentType: "text/event-stream", body: [
      { type: "text", answerId: "recovery-test", text: "画面検証用の再回答です。" },
      { type: "done", answerId: "recovery-test", answerability: "answerable", latencyMs: 1, firstTextMs: 1 },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.goto("/"); await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await input.fill("テスト質問"); await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByRole("region", { name: "AI面談", exact: true }).getByRole("alert")).toHaveText("ただいま準備中です。");
  await expect(input).toHaveValue("テスト質問");
  await page.getByRole("group", { name: "質問の候補" }).getByRole("button").first().click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByText("思い出しています…", { exact: true })).toHaveCount(1);
  await expect(page.getByText("回答は完了していません。", { exact: true })).toHaveCount(1);
  release!();
  await expect(page.getByText("画面検証用の再回答です。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "終了する" }).click();
  await expect(page.getByText("テスト質問", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("日本語変換中のEnterを送信と扱わない", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/chat", async route => { requests++; await route.abort(); });
  await page.goto("/"); await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await input.fill("面談"); await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }); await input.dispatchEvent("compositionend");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 });
  expect(requests).toBe(0); await expect(input).toHaveValue("面談");
});

test("再読込すると会話は残らず、AIとデータ処理先が明示される", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  await page.getByRole("textbox").fill("保存しない下書き");
  await page.reload(); await expect(page.getByRole("button", { name: "AI面談をはじめる" })).toBeVisible();
  await page.getByRole("link", { name: "このAIについて" }).click();
  await expect(page.getByRole("heading", { name: "このAIについて" })).toBeVisible();
  await expect(page.getByText(/処理にはCloudflareとGoogleのGemini APIを利用/)).toBeVisible();
});

for (const width of [320, 1440]) {
  test(`幅${width}pxで3往復しても質問候補が残り、毎回入れ替わる`, async ({ page }, testInfo) => {
    const requests: { message: string; history: unknown[] }[] = [];
    let release: (() => void) | undefined;
    await page.route("**/api/chat", async route => {
      requests.push(route.request().postDataJSON());
      await new Promise<void>(resolve => { release = resolve; });
      const events = [
        { type: "start", answerId: "browser-test" },
        { type: "text", answerId: "browser-test", text: "画面検証用の回答です。質問のあとも、次の話題を選べます。" },
        { type: "done", answerId: "browser-test", answerability: "answerable", latencyMs: 1, firstTextMs: 1 },
      ];
      await route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const candidates = page.getByRole("group", { name: "質問の候補" });
    const buttons = candidates.getByRole("button");
    const initial = await buttons.allTextContents();
    expect(initial).toHaveLength(3);
    expect(requests).toHaveLength(0);

    for (let round = 0; round < 3; round++) {
      const previous = await buttons.allTextContents();
      await buttons.first().click();
      await expect(page.getByText("思い出しています…", { exact: true })).toBeVisible();
      await expect.poll(() => requests.length).toBe(round + 1);
      for (const button of await buttons.all()) await expect(button).toBeDisabled();
      expect(requests[round].history).toHaveLength(round * 2);
      release!();
      await expect(buttons.first()).toBeEnabled();
      await expect(buttons).toHaveCount(3);
      expect(await buttons.allTextContents()).not.toEqual(previous);
      await expect(page.getByRole("textbox", { name: "質問を入力" })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const conversation = await page.getByRole("log", { name: "会話履歴" }).boundingBox();
      expect(conversation!.height).toBeGreaterThan(120);
    }
    await page.screenshot({ path: testInfo.outputPath(`chat-${width}px.png`), fullPage: true });
    await page.getByRole("button", { name: "終了する" }).click();
    expect(await buttons.allTextContents()).toEqual(initial);
    await expect(page.getByText("画面検証用の回答です。質問のあとも、次の話題を選べます。", { exact: true })).toHaveCount(0);
  });
}
