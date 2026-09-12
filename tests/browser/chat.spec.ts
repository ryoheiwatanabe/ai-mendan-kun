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

test("ヒット率は初期OFFで、過去の回答にも切り替えられ、本文と送信履歴に混ざらない", async ({ page }, testInfo) => {
  const requests: { message: string; history: unknown[] }[] = [];
  const percentages = [82, null, undefined, 0, 101];
  await page.route("**/api/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: [
      { type: "text", answerId: "diagnostics", text: `回答本文${requests.length}です。` },
      { type: "done", answerId: "diagnostics", answerability: "answerable", retrievalSimilarityPercent: percentages[requests.length - 1], latencyMs: 1, firstTextMs: 1 },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  const toggle = page.getByRole("switch", { name: "回答のヒット率を表示" });
  const metrics = page.getByRole("log", { name: "会話履歴" }).locator("small");
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await input.fill("質問1"); await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("回答本文1です。", { exact: true })).toBeVisible();
  await expect(metrics).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("検索類似度の参考値です。正答率ではありません。", { exact: true })).toBeVisible();
  await expect(metrics).toHaveText(["（回答のヒット率: 82%）"]);
  await expect(page.getByText("回答本文1です。", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-diagnostics-320px.png"), fullPage: true });
  await toggle.press("Space"); await expect(metrics).toHaveCount(0);
  await toggle.press("Space"); await expect(metrics).toHaveCount(1);
  for (let round = 2; round <= percentages.length; round++) {
    await input.fill(`質問${round}`); await page.getByRole("button", { name: "送信" }).click();
    await expect(page.getByText(`回答本文${round}です。`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  }
  expect(requests[1].history).toEqual([{ role: "user", content: "質問1" }, { role: "assistant", content: "回答本文1です。" }]);
  expect(JSON.stringify(requests)).not.toContain("ヒット率");
  expect(JSON.stringify(requests)).not.toContain("retrievalSimilarityPercent");
  await expect(metrics).toHaveText(["（回答のヒット率: 82%）", "（回答のヒット率: 算出対象外）", "（回答のヒット率: 算出対象外）", "（回答のヒット率: 0%）", "（回答のヒット率: 算出対象外）"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload(); await expect(toggle).not.toBeChecked();
  await expect(page.getByText("回答本文1です。", { exact: true })).toHaveCount(0);
});

test("ヒット率をONにしても生成途中・停止・失敗した回答には表示しない", async ({ page }) => {
  await page.addInitScript(() => {
    const state: any = { streams: [], requests: [], cancelled: [] };
    (window as any).chatDiagnosticsTest = state;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url !== "/api/chat") return originalFetch(url, options);
      state.requests.push(JSON.parse(options!.body as string));
      const index = state.requests.length - 1;
      return new Response(new ReadableStream({ start(controller) { state.streams.push(controller); }, cancel() { state.cancelled[index] = true; } }), { headers: { "Content-Type": "text/event-stream" } });
    };
    state.emit = (index: number, events: unknown[], end = false) => {
      if (state.cancelled[index]) return;
      state.streams[index].enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      if (end) state.streams[index].close();
    };
  });
  await page.goto("/"); await page.getByRole("switch", { name: "回答のヒット率を表示" }).click();
  await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  const input = page.getByRole("textbox", { name: "質問を入力" });
  const metrics = page.getByRole("log", { name: "会話履歴" }).getByText(/（回答のヒット率:/);
  await input.fill("停止する質問"); await page.getByRole("button", { name: "送信" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatDiagnosticsTest.requests.length)).toBe(1);
  await page.evaluate(() => (window as any).chatDiagnosticsTest.emit(0, [{ type: "text", answerId: "stopped", text: "生成途中の回答です。" }]));
  await expect(page.getByText("生成途中の回答です。", { exact: true })).toBeVisible();
  await expect(metrics).toHaveCount(0);
  await page.evaluate(() => (window as any).chatDiagnosticsTest.emit(0, [{ type: "done", answerId: "stopped", retrievalSimilarityPercent: 90 }]));
  await expect(metrics).toHaveCount(0);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatDiagnosticsTest.cancelled[0])).toBe(true);
  await page.evaluate(() => (window as any).chatDiagnosticsTest.emit(0, [{ type: "done", answerId: "stopped", retrievalSimilarityPercent: 90 }], true));
  await expect(metrics).toHaveCount(0);
  await input.fill("失敗する質問"); await page.getByRole("button", { name: "送信" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatDiagnosticsTest.requests.length)).toBe(2);
  await page.evaluate(() => (window as any).chatDiagnosticsTest.emit(1, [
    { type: "text", answerId: "failed", text: "失敗した回答の断片です。" },
    { type: "done", answerId: "failed", retrievalSimilarityPercent: 85 }, { type: "error", message: "回答を続けられませんでした。" }
  ], true));
  await expect(page.getByRole("region", { name: "AI面談", exact: true }).getByRole("alert")).toHaveText("回答を続けられませんでした。");
  await expect(metrics).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).chatDiagnosticsTest.requests[1].history)).toEqual([]);
  await input.fill("次の質問"); await page.getByRole("button", { name: "送信" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatDiagnosticsTest.requests.length)).toBe(3);
  expect(await page.evaluate(() => (window as any).chatDiagnosticsTest.requests[2].history)).toEqual([]);
  await page.getByRole("button", { name: "停止", exact: true }).click();
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
