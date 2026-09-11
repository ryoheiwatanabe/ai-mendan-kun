import { test, expect, chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const config = { enabled: true, processors: "CloudflareとGoogleのGemini API", speechProvider: "gemini", voiceName: "Kore", maxRecordingSeconds: 30, maxAudioBytes: 3_200_044 };
const wavView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const pcm = (value = 3000) => {
  const bytes = Buffer.alloc(4800);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(value, i);
  return bytes.toString("base64");
};
const audioEvent = (answerId: string, sequence = 0, value = 3000) => ({ type: "audio", answerId, sequence, data: pcm(value), mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 });
const doneEvent = (answerId: string) => ({ type: "done", answerId, answerability: "answerable", latencyMs: 1, firstTextMs: 1 });
const reply = (id = "voice-test", text = "承認された情報からの回答です。") => [
  { type: "start", answerId: id }, { type: "text", answerId: id, text }, audioEvent(id), doneEvent(id)
];
const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

// ブラウザーAPIだけをテスト内で差し替える。本番コードへテスト用の分岐は設けない。
async function fakeAudio(page: Page, denied = false) {
  await page.addInitScript(({ denied }) => {
    const state: any = { micCalls: 0, denied, tracks: [], contexts: [], sources: [], worklets: [], live: false, requests: [], streams: [] };
    (window as any).voiceTest = state;
    class Node {
      connected = false;
      connect() { this.connected = true; }
      disconnect() { this.connected = false; }
    }
    class Source extends Node {
      buffer: any = null;
      onended: (() => void) | null = null;
      started = false; stopped = false; when = 0;
      constructor(public context: Context) { super(); state.sources.push(this); }
      start(when = 0) { this.started = true; this.when = when; }
      stop() { this.stopped = true; }
      finish() { if (!this.stopped) { this.stopped = true; this.onended?.(); } }
    }
    class Context {
      state = "running"; sampleRate = 48_000; outputLatency = 0; destination = new Node();
      private at = performance.now(); private elapsed = 0;
      audioWorklet = { addModule: async (url: string) => { if (url !== "/audio-capture.js") throw new Error("unexpected_module"); } };
      constructor() { state.contexts.push(this); }
      get currentTime() { return this.elapsed + (this.state === "running" ? (performance.now() - this.at) / 1000 : 0); }
      getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
      async resume() {
        if (state.delayNextResume) {
          state.delayNextResume = false;
          await new Promise<void>(resolve => { state.releaseResume = resolve; });
          state.delayedResumeFinished = true;
        }
        if (this.state === "closed") return; this.at = performance.now(); this.state = "running";
      }
      async suspend() { this.elapsed = this.currentTime; this.state = "suspended"; }
      async close() { this.elapsed = this.currentTime; this.state = "closed"; }
      createMediaStreamSource() { return new Node(); }
      createGain() { return Object.assign(new Node(), { gain: { value: 1 } }); }
      createBuffer(_channels: number, frames: number, rate: number) {
        const data = new Float32Array(frames);
        return { duration: frames / rate, getChannelData: () => data };
      }
      createBufferSource() { return new Source(this); }
      async decodeAudioData() { const buffer = this.createBuffer(1, 2400, 24_000); buffer.getChannelData().fill(.04); return buffer; }
    }
    class Worklet extends Node {
      port = { onmessage: null as ((event: any) => void) | null, closed: false, close() { this.closed = true; } };
      constructor() { super(); state.worklets.push(this); }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: Context });
    Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: Worklet });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      async getUserMedia() {
        state.micCalls++;
        if (state.denied) throw new DOMException("test-denied", "NotAllowedError");
        if (state.permissionWait) await new Promise<void>(resolve => { state.allowMicrophone = resolve; });
        const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
        state.tracks.push(track);
        return { getTracks: () => [track] };
      }
    } });
    state.capture = (count: number, value = .12) => {
      for (let i = 0; i < count; i++) state.worklets.at(-1)?.port.onmessage?.({ data: new Float32Array(4800).fill(value) });
    };
    state.finish = () => { for (const source of [...state.sources]) if (source.started && !source.stopped) source.finish(); };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url === "/api/voice/chat" && state.live) {
        const request = { ...JSON.parse(options!.body as string), aborted: false, cancelled: false };
        state.requests.push(request);
        options?.signal?.addEventListener("abort", () => { request.aborted = true; });
        return new Response(new ReadableStream({
          start(controller) { state.streams.push(controller); }, cancel() { request.cancelled = true; }
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(url, options);
    };
    state.emit = (index: number, events: unknown[], end = false) => {
      state.streams[index].enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      if (end) state.streams[index].close();
    };
  }, { denied });
}
async function configure(page: Page, enabled = true) {
  await page.route("**/api/voice/config", route => route.fulfill({ json: { ...config, enabled } }));
  await page.route("**/audio/checking.wav", route => route.fulfill({ status: 404, body: "" }));
}
async function begin(page: Page) {
  await page.goto("/voice");
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
}
async function say(page: Page, automatic = true) {
  await page.evaluate(automatic => { const state = (window as any).voiceTest; state.capture(3); if (automatic) state.capture(7, 0); }, automatic);
  if (!automatic) await page.getByRole("button", { name: "発言を送る" }).click();
}
async function finishAudio(page: Page) { await page.evaluate(() => (window as any).voiceTest.finish()); }

test("音声の入口は設定が有効なときだけ表示し、開始前にマイクを開かない", async ({ page }) => {
  await fakeAudio(page); await configure(page, false);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "声で話してみる" })).toHaveCount(0);
  await page.goto("/voice");
  await expect(page.getByRole("heading", { name: "音声面談は準備中です" })).toBeVisible();
  await configure(page, true);
  await page.goto("/");
  await page.getByRole("link", { name: "声で話してみる" }).click();
  await expect(page.getByText(/CloudflareとGoogleのGemini APIへ音声/)).toBeVisible();
  await expect(page.getByText("標準の合成音声", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(0);
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByText("マイク使用中", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(1);
});

test("手動送信と発話終端でmono WAVを送り、再生完了した往復だけを履歴へ含める", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  const requests: any[] = [], recordings: Buffer[] = [];
  await page.route("**/api/voice/transcribe", route => {
    recordings.push(route.request().postDataBuffer()!);
    expect(route.request().headers()["content-type"]).toBe("audio/wav");
    return route.fulfill({ json: { text: recordings.length === 1 ? "最初の質問です" : "続きの質問です" } });
  });
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply(`answer-${requests.length}`)) });
  });
  await begin(page); await say(page, false);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await expect(page.getByText(/声が届くまで/)).toBeVisible();
  await expect(page.getByRole("button", { name: "回答を止める" })).toBeEnabled();
  expect(recordings[0].subarray(0, 4).toString()).toBe("RIFF");
  expect(wavView(recordings[0]).getUint16(22, true)).toBe(1); expect(wavView(recordings[0]).getUint32(24, true)).toBe(16_000); expect(wavView(recordings[0]).getUint16(34, true)).toBe(16);
  expect(requests[0].history).toEqual([]);
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await say(page);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].history).toEqual([{ role: "user", content: "最初の質問です" }, { role: "assistant", content: "承認された情報からの回答です。" }]);
  await page.getByRole("button", { name: "面談を終了" }).click();
  await expect(page.getByText("最初の質問です", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, stopped: (window as any).voiceTest.tracks.every((track: any) => track.stopped), closed: (window as any).voiceTest.contexts.every((context: any) => context.state === "closed") }))).toEqual({ local: 0, session: 0, stopped: true, closed: true });
});

test("AI発話中の短い相槌は再生を一時停止してから再開し、新しい質問にしない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0, answers = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "経歴を教えてください" : "はい。" } }));
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page); await say(page);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await page.evaluate(() => (window as any).voiceTest.capture(3));
  await expect(page.getByRole("heading", { name: "お話を聞いています" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("suspended");
  await page.getByRole("button", { name: "発言を送る" }).click();
  await expect(page.getByText("相槌を受け取り、回答を続けます。", { exact: true })).toBeVisible();
  expect(answers).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("running");
  expect(await page.evaluate(() => (window as any).voiceTest.sources.filter((source: any) => source.started).length)).toBe(1);
  await finishAudio(page); await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await say(page); await expect.poll(() => answers).toBe(2);
});

test("本当の割込は旧回答を中止し、遅着した音声と未完了の履歴を捨てる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "最初の質問" : "別の質問です" } }));
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; });
  await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events), reply("old", "古い回答の途中です。").slice(0, -1));
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).voiceTest.requests[0].aborted)).toBe(true);
  expect(await page.evaluate(() => (window as any).voiceTest.requests[1].history)).toEqual([]);
  expect(await page.evaluate(() => (window as any).voiceTest.sources[0].stopped)).toBe(true);
  await page.evaluate(events => (window as any).voiceTest.emit(1, events, true), reply("new", "新しい質問への回答です。"));
  await expect(page.getByText("新しい質問への回答です。", { exact: true })).toBeVisible();
  const count = await page.evaluate(() => (window as any).voiceTest.sources.length);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events), [
    { type: "text", answerId: "old", text: "遅れて到着した古い文" }, audioEvent("old", 1, 9000), doneEvent("old")
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests[0].cancelled)).toBe(true);
  await expect(page.getByText(/遅れて到着した古い文/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(count);
});

test("明示停止・画面非表示・再開で通信、音声、マイクを停止できる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "テスト質問" } }));
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.getByRole("button", { name: "回答を止める" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.requests[0].aborted)).toBe(true);
  await say(page); await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("button", { name: "もう一度はじめる" })).toBeVisible();
  await expect(page.getByText("テスト質問", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ stopped: (window as any).voiceTest.tracks.every((track: any) => track.stopped), closed: (window as any).voiceTest.contexts.every((context: any) => context.state === "closed"), aborted: (window as any).voiceTest.requests.every((request: any) => request.aborted) }))).toEqual({ stopped: true, closed: true, aborted: true });
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
  await page.getByRole("button", { name: "もう一度はじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.getByText("マイク停止中", { exact: true })).toBeVisible();
});

test("再生の再開待ち中に回答を止めたら、待機が解けても新しい質問を送らない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let answers = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "停止した質問" } }));
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.delayNextResume = true; }); await say(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.releaseResume)).toBe("function");
  expect(answers).toBe(0);
  await page.getByRole("button", { name: "回答を止める" }).click();
  await page.evaluate(() => (window as any).voiceTest.releaseResume());
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.delayedResumeFinished)).toBe(true);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await expect(page.getByRole("button", { name: "回答を止める" })).toBeDisabled();
  await expect(page.getByText("停止した質問", { exact: true })).toHaveCount(0);
  expect(answers).toBe(0);
  await say(page); await expect.poll(() => answers).toBe(1);
});

test("文字起こしと回答の429は固定の利用上限案内だけを表示する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let stage = "transcription", answers = 0;
  const privateDetail = "test-only-private-provider-key";
  await page.route("**/api/voice/transcribe", route => stage === "transcription"
    ? route.fulfill({ status: 429, json: { error: { message: privateDetail } } }) : route.fulfill({ json: { text: "利用上限のテスト質問" } }));
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ status: 429, json: { error: { message: privateDetail } } }); });
  await begin(page); await say(page);
  const alert = page.getByRole("region", { name: "音声AI面談" }).getByRole("alert");
  await expect(alert).toHaveText("音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。");
  expect(answers).toBe(0);
  stage = "answer"; await say(page); await expect.poll(() => answers).toBe(1);
  await expect(alert).toHaveText("音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。");
  await expect(page.locator("body")).not.toContainText(privateDetail);
});

test("SSEの回答上限は固定案内へ変換し、未知コードやAPI自由文を表示しない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let code = "VOICE_ANSWER_LIMIT";
  const requests: any[] = [];
  const privateDetail = "test-only-private-provider-response";
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "回答上限のテスト質問" } }));
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse([
      { type: "start", answerId: "limited" }, { type: "text", answerId: "limited", text: "途中までの回答です。" },
      { type: "error", code, message: privateDetail }
    ]) });
  });
  await begin(page); await say(page);
  const alert = page.getByRole("region", { name: "音声AI面談" }).getByRole("alert");
  await expect(alert).toHaveText("回答が長くなったため中断しました。質問を分けてお話しください。");
  code = "test-only-private-error-code"; await say(page);
  await expect(alert).toHaveText("回答を続けられませんでした。もう一度お話しください。");
  expect(requests[1].history).toEqual([]);
  await expect(page.locator("body")).not.toContainText(privateDetail);
  await expect(page.locator("body")).not.toContainText(code);
});

test("マイク拒否と文字起こし失敗から再開でき、エラー詳細を表示しない", async ({ page }) => {
  await fakeAudio(page, true); await configure(page);
  let calls = 0;
  await page.route("**/api/voice/transcribe", route => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: { message: "test-private-provider-detail" } } }) : route.fulfill({ json: { text: "再試行の質問" } }));
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }));
  await page.goto("/voice"); await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("マイク権限を許可");
  expect(await page.evaluate(() => (window as any).voiceTest.contexts.every((context: any) => context.state === "closed"))).toBe(true);
  await page.evaluate(() => { (window as any).voiceTest.denied = false; });
  await page.getByRole("button", { name: "もう一度はじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await say(page); await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("音声を聞き取れませんでした");
  await expect(page.getByText(/test-private-provider-detail/)).toHaveCount(0);
  await say(page); await expect(page.getByText("再試行の質問", { exact: true })).toBeVisible();
});

test("録音上限で自動送信し、WAVが30秒と最大bytesを超えない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let body: Buffer | null = null;
  await page.route("**/api/voice/transcribe", route => { body = route.request().postDataBuffer(); return route.fulfill({ json: { text: "長いテスト質問" } }); });
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }));
  await begin(page);
  await page.evaluate(() => (window as any).voiceTest.capture(310));
  await expect.poll(() => body?.byteLength ?? 0).toBeGreaterThan(44);
  const recording = body as unknown as Buffer;
  expect(recording.byteLength).toBeLessThanOrEqual(config.maxAudioBytes);
  expect((recording.byteLength - 44) / wavView(recording).getUint32(28, true)).toBeLessThanOrEqual(30);
});

test("マイク許可の待機中に終了しても、後から取得したtrackを直ちに停止する", async ({ page }) => {
  await fakeAudio(page); await configure(page); await page.goto("/voice");
  await page.evaluate(() => { (window as any).voiceTest.permissionWait = true; });
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByText("マイク許可を確認中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
  await page.evaluate(() => (window as any).voiceTest.allowMicrophone());
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.tracks[0]?.stopped)).toBe(true);
  await expect(page.getByText("マイク停止中", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.worklets.length)).toBe(0);
});

test("接続設定の失敗は再試行でき、音声未対応のブラウザーに開始ボタンを出さない", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: undefined }); });
  let available = false;
  await page.route("**/api/voice/config", route => available ? route.fulfill({ json: config }) : route.fulfill({ status: 503, body: "" }));
  await page.goto("/voice"); await expect(page.getByRole("button", { name: "接続をやり直す" })).toBeVisible();
  available = true; await page.getByRole("button", { name: "接続をやり直す" }).click();
  await expect(page.getByRole("heading", { name: "このブラウザーでは 音声を利用できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "音声面談をはじめる" })).toHaveCount(0);
});

test("連続PCMは隙間を入れず予約し、最後の音が終わるまで回答中を保つ", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "音が続く質問" } }));
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse([
    { type: "start", answerId: "continuous" }, { type: "text", answerId: "continuous", text: "連続する回答です。" },
    audioEvent("continuous", 0), audioEvent("continuous", 1), doneEvent("continuous")
  ]) }));
  await begin(page); await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(2);
  const sources = await page.evaluate(() => (window as any).voiceTest.sources.map((source: any) => ({ when: source.when, duration: source.buffer.duration })));
  expect(sources[1].when).toBeCloseTo(sources[0].when + sources[0].duration, 6);
  await page.evaluate(() => (window as any).voiceTest.sources[0].finish());
  await expect(page.getByRole("button", { name: "回答を止める" })).toBeEnabled();
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

for (const failure of ["incomplete", "wrong-sequence"]) {
  test(`${failure}の回答は音を止めて復帰し、次の質問の履歴に含めない`, async ({ page }) => {
    await fakeAudio(page); await configure(page);
    const requests: any[] = [];
    await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "テストの質問" } }));
    await page.route("**/api/voice/chat", route => {
      requests.push(route.request().postDataJSON());
      const events = requests.length > 1 ? reply() : failure === "incomplete" ? reply().slice(0, -1)
        : [{ type: "start", answerId: "voice-test" }, audioEvent("voice-test", 4), doneEvent("voice-test")];
      return route.fulfill({ contentType: "text/event-stream", body: sse(events) });
    });
    await begin(page); await say(page);
    await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("回答を続けられませんでした");
    expect(await page.evaluate(() => (window as any).voiceTest.sources.every((source: any) => source.stopped))).toBe(true);
    await say(page); await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].history).toEqual([]);
  });
}

test("補助音声は文字起こしの待ち中から1回だけ流れ、回答音声が届いたら停止する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let fillerCalls = 0;
  let release: (() => void) | undefined;
  await page.route("**/audio/checking.wav", route => { fillerCalls++; return route.fulfill({ contentType: "audio/wav", body: Buffer.from("mock-only") }); });
  await page.route("**/api/voice/transcribe", async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: { text: "少し待つ質問" } }); });
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect.poll(() => fillerCalls).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(1);
  await expect(page.getByText(/声が届くまで/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(0);
  release!();
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.sources[0].stopped)).toBe(false);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events, true), reply());
  await expect(page.getByText(/声が届くまで/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.sources[0].stopped)).toBe(true);
  expect(fillerCalls).toBe(1);
});

for (const width of [320, 1440]) {
  test(`音声ページは幅${width}pxで説明と操作が横にはみ出さない`, async ({ page }, testInfo) => {
    await fakeAudio(page); await configure(page); await page.setViewportSize({ width, height: 900 });
    await page.goto("/voice"); await expect(page.getByRole("button", { name: "音声面談をはじめる" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`voice-intro-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect(page.getByRole("button", { name: "発言を送る" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "面談を終了" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`voice-active-${width}.png`), fullPage: true });
  });
}

test("ネイティブWorkletは公開合成音声の偽マイクを収音し、再生・終了まで動く", async ({}, testInfo) => {
  const fixture = fileURLToPath(new URL("../../public/audio/checking.wav", import.meta.url));
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: [
    "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}%noloop`, "--use-fake-ui-for-media-stream", "--mute-audio"
  ] });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.addInitScript(() => {
      const state: any = { streams: [], contexts: [], worklets: [] };
      (window as any).nativeVoiceTest = state;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getUserMedia(constraints); state.streams.push(stream); return stream; };
      window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) { const value = Reflect.construct(target, args); state.contexts.push(value); return value; } });
      window.AudioWorkletNode = new Proxy(window.AudioWorkletNode, { construct(target, args) { const value = Reflect.construct(target, args); state.worklets.push(value); return value; } });
    });
    await configure(page);
    let captured: Buffer | null = null;
    await page.route("**/api/voice/transcribe", route => {
      captured = route.request().postDataBuffer();
      return route.fulfill({ json: { text: "確認しますね。" } });
    });
    await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply("native")) }));
    const navigation = await page.goto(`${testInfo.project.use.baseURL ?? "http://127.0.0.1:3000"}/voice`);
    expect(navigation?.headers()["permissions-policy"]).toContain("microphone=(self)");
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect.poll(() => captured?.byteLength ?? 0, { timeout: 15_000 }).toBeGreaterThan(44);
    await expect(page.getByText("確認しますね。", { exact: true })).toBeVisible();
    await expect(page.getByText(/声が届くまで/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
    const capture = captured as unknown as Buffer;
    expect(wavView(capture).getUint16(22, true)).toBe(1); expect(wavView(capture).getUint32(24, true)).toBe(16_000); expect(wavView(capture).getUint16(34, true)).toBe(16);
    // 偽マイクへ投入した公開済み合成音声だけを、再認識のローカル評価へ渡す。
    const output = new URL("../../.local/voice-eval/", import.meta.url);
    await mkdir(fileURLToPath(output), { recursive: true });
    await writeFile(new URL("captured.wav", output), capture);
    await page.getByRole("button", { name: "面談を終了" }).click();
    expect(await page.evaluate(() => ({
      tracksEnded: (window as any).nativeVoiceTest.streams.flatMap((stream: MediaStream) => stream.getTracks()).every((track: MediaStreamTrack) => track.readyState === "ended"),
      contextsClosed: (window as any).nativeVoiceTest.contexts.every((context: AudioContext) => context.state === "closed"),
      worklets: (window as any).nativeVoiceTest.worklets.length
    }))).toEqual({ tracksEnded: true, contextsClosed: true, worklets: 1 });
  } finally { await browser.close(); }
});
