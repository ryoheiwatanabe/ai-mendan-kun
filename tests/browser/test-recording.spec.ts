import { test, expect, chromium, type Page } from "@playwright/test";

type Event = { sessionId: string; type: string; data: Record<string, any> };
async function recording(page: Page) {
  const events: Event[] = [];
  await page.route("**/__test-recording/status", route => route.fulfill({ json: { enabled: true, healthy: true } }));
  await page.route("**/__test-recording/events", route => {
    events.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  return events;
}

test("文字の発言・回答・終了を同じタブIDで記録し、再読込後も送信済み記録を消さない", async ({ page }) => {
  const events = await recording(page), sessions: string[] = [];
  await page.route("**/api/chat", route => {
    sessions.push(route.request().headers()["x-test-recording-session"]);
    return route.fulfill({ contentType: "text/event-stream", body: [
      { type: "text", text: "記録を確かめる回答です。" }, { type: "done" }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.goto("/");
  await expect(page.getByText(/検証記録をこのMacに保存中/)).toBeVisible();
  await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  await page.getByRole("textbox").fill("保存を確認する質問");
  await page.getByRole("button", { name: "送信" }).click();
  await expect.poll(() => events.some(event => event.type === "text-state" && event.data.messages?.some((message: any) => message.content === "記録を確かめる回答です。" && message.complete))).toBe(true);
  const id = sessions[0];
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(events.every(event => event.sessionId === id)).toBe(true);
  await page.getByRole("button", { name: "終了する" }).click();
  await expect.poll(() => events.some(event => event.type === "text-end")).toBe(true);
  const oldCount = events.filter(event => event.sessionId === id).length;
  await page.reload();
  await expect.poll(() => events.some(event => event.sessionId !== id)).toBe(true);
  expect(events.filter(event => event.sessionId === id).length).toBeGreaterThanOrEqual(oldCount);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("記録用proxyがない通常画面では保存案内・イベント送信を追加しない", async ({ page }) => {
  let writes = 0;
  await page.route("**/__test-recording/**", route => {
    if (route.request().method() === "POST") writes++;
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByText("会話の記録なし", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "AI面談をはじめる" }).click();
  await page.getByRole("button", { name: "終了する" }).click();
  expect(writes).toBe(0);
  await expect(page.getByText(/検証記録をこのMac/)).toHaveCount(0);
});

test("初回の記録状態確認に失敗したら会話を送信しない", async ({ page }) => {
  let requests = 0;
  await page.route("**/__test-recording/status", route => route.fulfill({ status: 503 }));
  await page.route("**/__test-recording/events", route => route.fulfill({ status: 204 }));
  await page.route("**/api/chat", route => { requests++; return route.abort(); });
  await page.goto("/");
  await expect(page.getByText(/検証記録を保存できません/)).toBeVisible();
  await expect(page.getByRole("group", { name: "質問の候補" }).getByRole("button").first()).toBeDisabled();
  expect(requests).toBe(0);
});

test("聞き取りに送る前の実MediaRecorder音声と再生中断を記録し、保存失敗時は停止する", async ({}, testInfo) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: [
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"
  ] });
  try {
    const page = await browser.newPage(), events = await recording(page);
    const chunks: { capture: string; sequence: number; bytes: number }[] = [], ends: any[] = [];
    let transcriptions = 0, failSaving = false;
    await page.route("**/__test-recording/microphone?**", route => {
      const query = new URL(route.request().url()).searchParams;
      chunks.push({ capture: query.get("capture")!, sequence: Number(query.get("sequence")), bytes: route.request().postDataBuffer()!.length });
      return route.fulfill({ status: failSaving ? 503 : 204 });
    });
    await page.route("**/__test-recording/microphone-end", route => { ends.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); });
    await page.route("**/api/voice/config", route => route.fulfill({ json: {
      enabled: true, processors: "検証用API", voiceName: "Kore", maxRecordingSeconds: 30, maxAudioBytes: 3_200_044
    } }));
    // VADを利用できない環境でも、マイクの連続保存が継続することを確認する。
    await page.route("**/vad/**", route => route.fulfill({ status: 404 }));
    await page.route("**/api/voice/transcribe", route => { transcriptions++; return route.fulfill({ json: { text: "記録の検証です" } }); });
    const pcm = Buffer.alloc(48_000 * 4).toString("base64");
    await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: [
      { type: "start", answerId: "recording-playback" },
      { type: "text", answerId: "recording-playback", text: "再生の途中で停止する回答です。" },
      { type: "audio", answerId: "recording-playback", sequence: 0, data: pcm, mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
      { type: "done", answerId: "recording-playback" }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") }));
    await page.goto(`${testInfo.project.use.baseURL}/voice`);
    await expect(page.getByText(/検証記録をこのMacに保存中/)).toBeVisible();
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect.poll(() => chunks.length).toBeGreaterThan(0);
    expect(transcriptions).toBe(0);
    expect(chunks[0].bytes).toBeGreaterThan(0);
    await page.getByRole("button", { name: "録音を開始", exact: true }).click();
    await expect.poll(() => chunks.length).toBeGreaterThan(1);
    await page.getByRole("button", { name: "発言を送る" }).click();
    await expect.poll(() => events.some(event => event.type === "playback-first")).toBe(true);
    await page.getByRole("button", { name: "回答を止める" }).click();
    await expect.poll(() => events.some(event => event.type === "playback-cancel" && event.data.answerId === "recording-playback")).toBe(true);
    await page.getByRole("button", { name: "面談を終了" }).click();
    await expect.poll(() => ends.length).toBe(1);
    await expect.poll(() => chunks.filter(chunk => chunk.capture === ends[0].captureId).length).toBe(ends[0].count);
    expect(chunks.filter(chunk => chunk.capture === ends[0].captureId).map(chunk => chunk.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: ends[0].count }, (_, i) => i));
    await page.getByRole("button", { name: "もう一度はじめる" }).click();
    failSaving = true;
    await expect(page.getByText(/検証記録を保存できません/)).toBeVisible();
    await expect(page.getByRole("button", { name: "もう一度はじめる" })).toBeDisabled();
    await expect.poll(() => ends.length).toBe(2);
    expect(events.some(event => event.type === "voice-state" && event.data.messages?.some((message: any) => message.content === "記録の検証です"))).toBe(true);
  } finally { await browser.close(); }
});
