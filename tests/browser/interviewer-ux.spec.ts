import { test, expect, type Page, type Route } from "@playwright/test";

const voiceConfig = { enabled: true, speak: false, processors: "検証用の外部API", speechProvider: "Gemini", voiceName: "Kore",
  maxRecordingSeconds: 30, maxAudioBytes: 3_200_044, playbackRate: 1.2 };
const longAnswer = "担当した仕事では、課題を整理して進め方を決め、関係者と確認しました。".repeat(8);
const reply = (route: Route, text = longAnswer) => route.fulfill({ contentType: "text/event-stream", body: [
  { type: "start", answerId: "ux-test" }, { type: "input", question: route.request().postDataJSON().message },
  { type: "text", answerId: "ux-test", text }, { type: "done", answerId: "ux-test", answerability: "answerable" }
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });

async function setup(page: Page, voice = false) {
  await page.route("**/api/voice/config", route => route.fulfill({ json: voiceConfig }));
  await page.route("**/__test-recording/**", route => route.fulfill({ status: 404 }));
  await page.addInitScript(() => {
    (window as any).uxMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { (window as any).uxMicCalls++; throw new Error("No real microphone in UI tests"); };
  });
  await page.goto(voice ? "/voice" : "/");
  if (voice) {
    await page.getByRole("radio", { name: /手入力で質問する/ }).check();
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect(page.getByText("文字入力中（マイク不使用）", { exact: true })).toBeVisible();
  } else await page.getByRole("button", { name: "テキストはこちら" }).click();
}

for (const voice of [false, true]) test(`${voice ? "音声" : "文字"}で説明を開閉しても会話・下書き・読み位置を失わない`, async ({ page }) => {
  await page.route(voice ? "**/api/voice/chat" : "**/api/chat", route => reply(route));
  await setup(page, voice);
  const input = page.getByRole("textbox", { name: "質問を入力" });
  const send = voice ? page.locator(".voice-typed").getByRole("button", { name: "送る" }) : page.getByRole("button", { name: "送信" });
  const log = page.getByRole("log");
  for (let round = 1; round <= 2; round++) {
    await input.fill(`経験についての質問${round}`); await send.click();
    await expect(log.getByText(longAnswer, { exact: true })).toHaveCount(round); await expect(send).toBeVisible();
    await expect(voice ? page.getByRole("button", { name: "回答を止める" }) : page.getByRole("button", { name: "停止", exact: true })).toHaveCount(voice ? 1 : 0);
  }
  await input.fill("次に確認したい下書き");
  await log.evaluate(element => { element.scrollTop = 0; });
  const before = await log.innerText();
  const trigger = page.getByRole("button", { name: "このAIについて", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "このAIについて", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /閉じる/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  await expect(input).toHaveValue("次に確認したい下書き");
  expect(await log.innerText()).toBe(before); expect(await log.evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  if (voice) expect(await page.evaluate(() => (window as any).uxMicCalls)).toBe(0);
  await page.getByRole("button", { name: voice ? "面談を終了" : "終了する", exact: true }).click();
  await expect(log).toHaveCount(0); await expect(input).toHaveCount(0);
});

for (const width of [320, 414, 768, 1366]) for (const voice of [false, true]) test(`${width}pxの${voice ? "音声" : "文字"}面談で履歴の下から入力できる`, async ({ page }) => {
  await page.setViewportSize({ width, height: width < 768 ? 667 : 768 });
  await page.route(voice ? "**/api/voice/chat" : "**/api/chat", route => reply(route));
  await setup(page, voice);
  await page.getByRole("textbox", { name: "質問を入力" }).fill("これまでの経験について");
  await page.getByRole("button", { name: voice ? "送る" : "送信", exact: voice }).click();
  await expect(page.getByRole("log")).toContainText(longAnswer);
  const history = (await page.getByRole("log").boundingBox())!;
  const input = (await page.getByRole("textbox", { name: "質問を入力" }).boundingBox())!;
  expect(history.height).toBeGreaterThan(voice ? 96 : 200);
  expect(input.y).toBeGreaterThan(history.y + history.height);
  expect(input.y + input.height).toBeLessThanOrEqual(width < 768 ? 667 : 768);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

for (const ending of ["failure", "success", "stop", "cleared"] as const) test(`送信後の下書きを${ending}で上書きしない`, async ({ page }) => {
  let release: (() => void) | undefined, calls = 0;
  await page.route("**/api/chat", async route => {
    if (++calls > 1) return reply(route, "再送した回答です。");
    await new Promise<void>(resolve => { release = resolve; });
    if (ending === "failure" || ending === "cleared") return route.fulfill({ status: 503, json: { error: { message: "検証用の接続失敗です。" } } });
    return reply(route, "最初の回答です。");
  });
  await setup(page);
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await input.fill("送信する質問A"); await page.getByRole("button", { name: "送信" }).click();
  await expect.poll(() => !!release).toBe(true);
  await input.fill("次の質問B");
  if (ending === "cleared") await input.fill("");
  if (ending === "stop") await page.getByRole("button", { name: "停止", exact: true }).click();
  release!();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(input).toHaveValue(ending === "cleared" ? "" : "次の質問B");
  if (ending === "stop") expect(calls).toBe(1);
  if (ending === "failure") {
    await page.getByRole("button", { name: "もう一度送る", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("再送した回答です。");
    await expect(input).toHaveValue("次の質問B");
  }
});

test("候補は下書きを保って送信し、375pxでは会話の高さを確保する", async ({ page }) => {
  const sent: string[] = [];
  await page.route("**/api/chat", route => { sent.push(route.request().postDataJSON().message); return reply(route, "候補への回答です。"); });
  await page.setViewportSize({ width: 375, height: 667 });
  await setup(page);
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await input.fill("自分で考えた次の質問");
  await page.locator(".question-choices summary").click();
  const choice = page.getByRole("group", { name: "質問の候補" }).getByRole("button").first();
  const question = (await choice.innerText()).replace("↗", "").trim();
  await choice.click(); await expect(page.getByRole("log")).toContainText("候補への回答です。");
  expect(sent).toEqual([question]); await expect(input).toHaveValue("自分で考えた次の質問");
  await expect(page.locator(".question-choices")).not.toHaveAttribute("open", "");
  expect((await page.getByRole("log").boundingBox())!.height).toBeGreaterThan(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

for (const voice of [false, true]) test(`${voice ? "音声" : "文字"}の読み返し位置を新着で動かさず、操作で末尾へ進める`, async ({ page }) => {
  let calls = 0, release: (() => void) | undefined;
  await page.route(voice ? "**/api/voice/chat" : "**/api/chat", async route => {
    if (++calls === 3) await new Promise<void>(resolve => { release = resolve; });
    return reply(route, longAnswer + calls);
  });
  await page.setViewportSize({ width: 375, height: 667 });
  await setup(page, voice);
  const input = page.getByRole("textbox", { name: "質問を入力" });
  const send = voice ? page.locator(".voice-typed").getByRole("button", { name: "送る" }) : page.getByRole("button", { name: "送信" });
  const log = page.getByRole("log");
  for (let round = 1; round <= 2; round++) {
    await input.fill(`質問${round}`); await send.click();
    await expect(log).toContainText(longAnswer + round);
    if (voice) await expect(page.getByRole("button", { name: "回答を止める" })).toBeDisabled();
    else await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  }
  await input.fill("質問3"); await send.click(); await expect.poll(() => !!release).toBe(true);
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  release!(); await expect(log).toContainText(longAnswer + 3);
  expect(await log.evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "新しい回答へ ↓", exact: true }).click();
  await expect.poll(() => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  if (voice) {
    const history = (await log.boundingBox())!, composer = (await page.locator(".voice-typed").boundingBox())!;
    await expect(page.getByText("続けて、気になることを入力してください。", { exact: true })).toBeVisible();
    expect(composer.y).toBeGreaterThanOrEqual(history.y + history.height - 1);
    expect(composer.y - history.y - history.height).toBeLessThan(3);
    expect(history.height).toBeGreaterThan(120);
    expect(composer.y + composer.height).toBeLessThanOrEqual(667);
    expect(await page.evaluate(() => (window as any).uxMicCalls)).toBe(0);
    await input.fill("日本語変換"); await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true }); await input.dispatchEvent("compositionend");
    expect(calls).toBe(3); await expect(input).toHaveValue("日本語変換");
  }
});
