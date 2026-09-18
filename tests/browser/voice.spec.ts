import { test, expect, chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const config = { enabled: true, processors: "CloudflareとGoogleのGemini API", speechProvider: "gemini", voiceName: "Kore", maxRecordingSeconds: 30, maxAudioBytes: 3_200_044, playbackRate: 1.2 };
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

// VADのscript読み込み境界だけを差し替える。人声・打鍵の分類はfixtureの指定であり、
// Sileroの実精度はネイティブマイクと実モデルのケースで別に確認する。
function installFakeVad() {
  const state = (window as any).voiceTest;
  class MicVAD {
    listening = false; destroyed = false; failNextFrame = false;
    frames: Float32Array[] = []; speechSamples = 0; silenceSamples = 0; speaking = false; realStart = false;
    model = { release: async () => { this.destroyed = true; } };
    constructor(public options: any) { state.vads.push(this); }
    static async new(options: any) {
      options.ortConfig?.((window as any).ort);
      return new MicVAD(options);
    }
    reset() { this.frames = []; this.speechSamples = 0; this.silenceSamples = 0; this.speaking = false; this.realStart = false; }
    async start() { if (!this.destroyed) { await this.options.getStream(); this.listening = true; } }
    async pause() {
      this.listening = false;
      if (this.options.submitUserSpeechOnPause) this.end(); else this.reset();
    }
    async destroy() { await this.pause(); await this.model.release(); }
    setOptions(options: any) { Object.assign(this.options, options); }
    end() {
      const frames = this.frames, valid = this.realStart, speaking = this.speaking;
      this.reset();
      if (!speaking) return;
      if (!valid) { this.options.onVADMisfire?.(); return; }
      const audio = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
      let offset = 0;
      for (const frame of frames) { audio.set(frame, offset); offset += frame.length; }
      this.options.onSpeechEnd?.(audio);
    }
    processFrame = async (frame: Float32Array) => {
      if (!this.listening || this.destroyed) return;
      if (this.failNextFrame) { this.failNextFrame = false; throw new Error("fake_inference_failed"); }
      // 100msの.12フレームは擬似人声、短い打鍵フレームと0は非人声として渡す。
      const voiced = frame.length >= 1600 && Math.abs(frame[0] ?? 0) > .018;
      this.options.onFrameProcessed?.({ isSpeech: voiced ? .95 : .01, notSpeech: voiced ? .05 : .99 }, frame);
      if (voiced && !this.speaking) { this.speaking = true; this.options.onSpeechStart?.(); }
      if (!this.speaking) return;
      this.frames.push(frame);
      if (voiced) {
        this.speechSamples += frame.length; this.silenceSamples = 0;
        if (!this.realStart && this.speechSamples >= this.options.minSpeechMs * 16) {
          this.realStart = true; this.options.onSpeechRealStart?.();
        }
      } else this.silenceSamples += frame.length;
      // このfakeの時間単位は100ms。終端時間に達する最初のフレームで区切る。
      if (this.silenceSamples >= this.options.redemptionMs * 16) this.end();
    };
  }
  (window as any).vad = { MicVAD };
}

// ブラウザーAPIのfakeは維持し、本番コードへテスト用の分岐を設けない。
async function fakeAudio(page: Page, denied = false) {
  await page.route("**/vad/ort.wasm.min.js", route => route.fulfill({ contentType: "text/javascript", body: "window.ort = { env: { wasm: {} } };" }));
  await page.route("**/vad/bundle.min.js", route => route.fulfill({ contentType: "text/javascript", body: `(${installFakeVad.toString()})();` }));
  await page.addInitScript(({ denied }) => {
    const state: any = { micCalls: 0, denied, tracks: [], contexts: [], sources: [], worklets: [], vads: [], live: false, requests: [], streams: [] };
    (window as any).voiceTest = state;
    class Node {
      connected = false;
      connect() { this.connected = true; }
      disconnect() { this.connected = false; }
    }
    class Source extends Node {
      buffer: any = null;
      playbackRate = { value: 1 };
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
        const ended: (() => void)[] = [];
        const track = {
          stopped: false, readyState: "live", label: "MacBook Airのマイク",
          stop() { this.stopped = true; this.readyState = "ended"; },
          addEventListener(type: string, listener: () => void) { if (type === "ended") ended.push(listener); },
          end() {
            if (this.readyState === "ended") return;
            this.stopped = true; this.readyState = "ended";
            for (const listener of ended.splice(0)) listener();
          }
        };
        state.tracks.push(track);
        return { getTracks: () => [track] };
      }
    } });
    state.capture = async (count: number, value = .12) => {
      for (let i = 0; i < count; i++) {
        const vad = state.vads.at(-1);
        if (vad?.listening && !vad.destroyed) await vad.processFrame(new Float32Array(1600).fill(value));
        else state.worklets.at(-1)?.port.onmessage?.({ data: new Float32Array(4800).fill(value) });
      }
    };
    state.tap = async () => { await state.vads.at(-1)?.processFrame(new Float32Array(333).fill(.12)); };
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
      // 中断済みの通信へ遅着したチャンクはブラウザー同様に破棄する。
      if (state.requests[index].cancelled) { state.dropped = (state.dropped ?? 0) + events.length; return; }
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
  await page.evaluate(async automatic => { const state = (window as any).voiceTest; await state.capture(3); if (automatic) await state.capture(13, 0); }, automatic);
  if (!automatic) await page.getByRole("button", { name: "発言を送る" }).click();
}
async function finishAudio(page: Page) { await page.evaluate(() => (window as any).voiceTest.finish()); }
// 模擬音声の再生を終わらせ、回答が確定するまで待つ。実行環境の負荷で
// 再生開始が遅れても、開始しだい終わらせる。
async function settle(page: Page) {
  await expect.poll(async () => {
    await finishAudio(page);
    return page.getByRole("button", { name: "回答を止める" }).isDisabled();
  }, { timeout: 20_000 }).toBe(true);
}

// 中断を無視して遅着するSTTも再現し、音声の連結とchatへの確定を独立に確認する。
async function holdTranscriptions(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).voiceTest, original = window.fetch.bind(window);
    state.transcriptions = [];
    window.fetch = (url, options) => {
      if (url !== "/api/voice/transcribe") return original(url, options);
      const request: any = { body: options!.body, aborted: false };
      state.transcriptions.push(request);
      options!.signal!.addEventListener("abort", () => { request.aborted = true; });
      return new Promise<Response>(resolve => { request.finish = (text: string, status = 200) =>
        resolve(new Response(JSON.stringify({ text }), { status, headers: { "Content-Type": "application/json" } })); });
    };
  });
}

test("文字起こし前の検知と音声生成待ちを表示し、再生開始・終了で消す", async ({ page }, testInfo) => {
  await fakeAudio(page); await configure(page); await holdTranscriptions(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await begin(page);
  await page.evaluate(async () => { (window as any).voiceTest.live = true; await (window as any).voiceTest.capture(3); });
  const transcript = page.getByRole("log", { name: "音声の会話履歴" });
  await expect(transcript.getByText("声を検知しました。聞いています…", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.transcriptions.length)).toBe(0);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect(transcript.getByText("お話を文字にしています…", { exact: true })).toBeVisible();
  await expect(transcript.getByText("声を検知しました。聞いています…", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("transcribing-feedback.png"), fullPage: true });
  await page.evaluate(() => (window as any).voiceTest.transcriptions[0].finish("今回の質問です"));
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.evaluate(() => (window as any).voiceTest.emit(0, [{ type: "start", answerId: "progress" }, { type: "text", answerId: "progress", text: "今回の回答です。" }]));
  const generating = transcript.getByText("音声を生成しています…", { exact: true });
  await expect(generating).toBeVisible();
  await expect(transcript.getByText("お話を文字にしています…", { exact: true })).toHaveCount(0);
  expect(await generating.locator(".voice-progress-spinner").evaluate(el => getComputedStyle(el).animationName)).toBe("voice-spin");
  await page.screenshot({ path: testInfo.outputPath("audio-generation-feedback.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await generating.locator(".voice-progress-spinner").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  await page.evaluate(events => (window as any).voiceTest.emit(0, events, true), [audioEvent("progress"), doneEvent("progress")]);
  await expect(generating).toHaveCount(0);
  await finishAudio(page);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await expect(transcript.getByText("声を検知しました。聞いています…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
  await expect(page.getByText("声を検知しました。聞いています…", { exact: true })).toHaveCount(0);
});

test("文ごとの音声の間も生成中を示し、読み終えた待ち時間を止まって見せない", async ({ page }) => {
  await fakeAudio(page); await configure(page); await holdTranscriptions(page);
  await begin(page);
  await page.evaluate(async () => { (window as any).voiceTest.live = true; await (window as any).voiceTest.capture(3); });
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await page.evaluate(() => (window as any).voiceTest.transcriptions[0].finish("今回の質問です"));
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  const transcript = page.getByRole("log", { name: "音声の会話履歴" });
  const generating = transcript.getByText("音声を生成しています…", { exact: true });
  // 文が届いてから1文目の音声が来るまでは生成中を示す。
  await page.evaluate(events => (window as any).voiceTest.emit(0, events),
    [{ type: "start", answerId: "parts" }, { type: "text", answerId: "parts", text: "1文目の回答です。2文目の回答です。" }]);
  await expect(generating).toBeVisible();
  // 1文目を読み終えたら、2文目の音声を待つ間も生成中を示す。
  await page.evaluate(events => (window as any).voiceTest.emit(0, events), [audioEvent("parts", 0)]);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await finishAudio(page);
  await expect(generating).toBeVisible();
  // 2文目が届けば消え、読み終えるまで回答中として扱う。
  await page.evaluate(events => (window as any).voiceTest.emit(0, events, true), [audioEvent("parts", 1), doneEvent("parts")]);
  await expect(generating).toHaveCount(0);
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("検証記録の保存に失敗しても面談を終了せず、案内だけを出す", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/__test-recording/status", route => route.fulfill({ json: { enabled: true, healthy: true } }));
  await page.route("**/__test-recording/events", route => route.fulfill({ status: 204 }));
  await page.route("**/__test-recording/microphone**", route => route.fulfill({ status: 500 }));
  await begin(page);
  // マイク音声の保存に失敗しても、面談は続いたまま案内だけを出す。
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("検証記録を保存できません");
  await expect(page.getByRole("button", { name: "面談を終了" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("900msの中間休止は同じ発言に収め、前半と後半を一度だけ文字起こしする", async ({ page }) => {
  await fakeAudio(page); await configure(page); await holdTranscriptions(page);
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page);
  await page.evaluate(async () => {
    const state = (window as any).voiceTest;
    await state.capture(3, .12); await state.capture(9, 0);
  });
  expect(await page.evaluate(() => (window as any).voiceTest.transcriptions.length)).toBe(0);
  await page.evaluate(async () => {
    const state = (window as any).voiceTest;
    await state.capture(3, .24); await state.capture(13, 0);
  });
  expect(await page.evaluate(() => {
    const items = (window as any).voiceTest.transcriptions, data = new DataView(items[0].body);
    return { count: items.length, first: data.getInt16(44, true), last: data.getInt16(44 + 12 * 1600 * 2, true) };
  })).toEqual({ count: 1, first: 3932, last: 7864 });
  await page.evaluate(() => (window as any).voiceTest.transcriptions[0].finish("ブロックチェーンゲームコミュニティって具体的な名前は？"));
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("ブロックチェーンゲームコミュニティって具体的な名前は？");
});

for (const ending of ["automatic", "manual"] as const) {
  test(`STT待ちで発話が再開したら前半を保持し、${ending}終端後の全文だけを一度回答する`, async ({ page }) => {
    await fakeAudio(page); await configure(page); await holdTranscriptions(page);
    const requests: any[] = [];
    await page.route("**/api/voice/chat", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
    await begin(page); await say(page);
    await page.evaluate(async () => {
      const state = (window as any).voiceTest;
      await state.capture(3, .24);
      state.transcriptions[0].finish("ブロックチェーンゲームコミュニティ");
    });
    await expect(page.getByRole("heading", { name: "お話を聞いています" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).voiceTest.transcriptions[0].aborted)).toBe(true);
    expect(requests).toEqual([]);
    await expect(page.getByText("ブロックチェーンゲームコミュニティ", { exact: true })).toHaveCount(0);
    if (ending === "automatic") await page.evaluate(() => (window as any).voiceTest.capture(13, 0));
    else await page.getByRole("button", { name: "発言を送る" }).click();
    expect(await page.evaluate(() => {
      const items = (window as any).voiceTest.transcriptions;
      const first = new Uint8Array(items[0].body), joined = new Uint8Array(items[1].body);
      const prefix = first.slice(44).every((value, index) => joined[44 + index] === value);
      return { count: items.length, prefix, continuation: new DataView(items[1].body).getInt16(first.length, true) };
    })).toEqual({ count: 2, prefix: true, continuation: 7864 });
    if (ending === "manual") {
      await page.evaluate(async () => { const state = (window as any).voiceTest; await state.capture(3, .36); await state.capture(13, 0); });
      expect(await page.evaluate(() => (window as any).voiceTest.transcriptions.length)).toBe(2);
    }
    await page.evaluate(() => (window as any).voiceTest.transcriptions[1].finish("ブロックチェーンゲームコミュニティって具体的な名前は？"));
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].message).toBe("ブロックチェーンゲームコミュニティって具体的な名前は？");
    expect(requests[0].history).toEqual([]);
  });
}

test("継続発言の累積30秒で確定し、前半と残り予算内の後半を保持する", async ({ page }) => {
  await fakeAudio(page); await configure(page); await holdTranscriptions(page);
  let answers = 0;
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page);
  await page.evaluate(async () => {
    const state = (window as any).voiceTest;
    await state.capture(170, .12); await state.capture(13, 0);
    await state.capture(170, .24);
  });
  const capture = await page.evaluate(() => {
    const items = (window as any).voiceTest.transcriptions, first = new Uint8Array(items[0].body), joined = new Uint8Array(items[1].body);
    return { count: items.length, seconds: (joined.length - 44) / 32000, prefix: first.slice(44).every((value, index) => value === joined[44 + index]),
      last: new DataView(items[1].body).getInt16(joined.length - 2, true), bytes: joined.length };
  });
  expect(capture.count).toBe(2); expect(capture.prefix).toBe(true); expect(capture.last).toBe(7864);
  expect(capture.seconds).toBeGreaterThan(29); expect(capture.seconds).toBeLessThanOrEqual(30); expect(capture.bytes).toBeLessThanOrEqual(config.maxAudioBytes);
  await page.evaluate(() => {
    const items = (window as any).voiceTest.transcriptions;
    items[0].finish("前半だけの古い結果"); items[1].finish("上限まで含む質問");
  });
  await expect.poll(() => answers).toBe(1);
  await expect(page.getByText("前半だけの古い結果", { exact: true })).toHaveCount(0);
});

for (const prefixResult of ["はい", ""]) {
  test(`相槌・発言なし「${prefixResult}」の再開待ちで続けて話したら、再生を止めたまま全文を待つ`, async ({ page }) => {
    await fakeAudio(page); await configure(page); await holdTranscriptions(page);
    await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
    await page.evaluate(() => (window as any).voiceTest.transcriptions[0].finish("経歴を教えてください"));
    await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
    await page.evaluate(events => (window as any).voiceTest.emit(0, events), reply("old").slice(0, -1));
    await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
    await say(page);
    await page.evaluate(prefixResult => {
      const state = (window as any).voiceTest; state.delayNextResume = true; state.transcriptions[1].finish(prefixResult);
    }, prefixResult);
    await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.releaseResume)).toBe("function");
    await page.evaluate(async () => { const state = (window as any).voiceTest; await state.capture(3, .24); state.releaseResume(); });
    await expect.poll(() => page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("suspended");
    await expect(page.getByRole("heading", { name: "お話を聞いています" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
    await page.evaluate(async () => {
      const state = (window as any).voiceTest; await state.capture(13, 0); state.transcriptions[2].finish("はい、コミュニティの具体的な名前は？");
    });
    await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
    expect(await page.evaluate(() => ({ aborted: (window as any).voiceTest.requests[0].aborted, text: (window as any).voiceTest.requests[1].message })))
      .toEqual({ aborted: true, text: "はい、コミュニティの具体的な名前は？" });
  });
}

for (const action of ["stop", "close", "failure", "429"] as const) {
  test(`継続発言中の${action}で保持音声を破棄し、遅着STTから回答しない`, async ({ page }) => {
    await fakeAudio(page); await configure(page); await holdTranscriptions(page);
    const requests: any[] = [];
    await page.route("**/api/voice/chat", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
    await begin(page); await say(page);
    await page.evaluate(() => (window as any).voiceTest.capture(3, .24));
    if (action === "failure") {
      await page.evaluate(async () => { const state = (window as any).voiceTest; state.vads.at(-1).failNextFrame = true; await state.capture(1); });
      await expect(page.getByRole("button", { name: "録音を開始" })).toBeEnabled();
    } else {
      await page.evaluate(() => (window as any).voiceTest.capture(13, 0));
      if (action === "stop") await page.getByRole("button", { name: "回答を止める" }).click();
      if (action === "close") await page.getByRole("button", { name: "面談を終了" }).click();
      if (action === "429") {
        await page.evaluate(() => (window as any).voiceTest.transcriptions[1].finish("", 429));
        await expect(page.getByRole("button", { name: "聞き取りを再開" })).toBeVisible();
      }
    }
    await page.evaluate(() => { for (const item of (window as any).voiceTest.transcriptions) item.finish("破棄した発言"); });
    await expect(page.getByText("破棄した発言", { exact: true })).toHaveCount(0);
    expect(requests).toEqual([]);
    if (action === "close") return;
    if (action === "429") {
      await say(page); expect(await page.evaluate(() => (window as any).voiceTest.transcriptions.length)).toBe(2);
      await page.getByRole("button", { name: "聞き取りを再開" }).click();
    }
    if (action === "failure") await page.getByRole("button", { name: "録音を開始" }).click();
    await page.evaluate(() => (window as any).voiceTest.capture(3, .36));
    await page.getByRole("button", { name: "発言を送る" }).click();
    expect(await page.evaluate(() => new DataView((window as any).voiceTest.transcriptions.at(-1).body).getInt16(44, true))).toBe(11796);
    await page.evaluate(() => (window as any).voiceTest.transcriptions.at(-1).finish("破棄後の新しい質問"));
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].message).toBe("破棄後の新しい質問");
  });
}

test("旧回答の429が継続発言のSTT待ちに届いたら、文字起こしも中断して聞き取りを止める", async ({ page }) => {
  await fakeAudio(page); await configure(page); await holdTranscriptions(page);
  let answers = 0, releaseAnswer!: () => void;
  const heldAnswer = new Promise<void>(resolve => { releaseAnswer = resolve; });
  await page.route("**/api/voice/chat", async route => { answers++; await heldAnswer; await route.fulfill({ status: 429, body: "" }); });
  await begin(page); await say(page);
  await page.evaluate(() => (window as any).voiceTest.transcriptions[0].finish("最初の質問"));
  await expect.poll(() => answers).toBe(1);
  await say(page);
  releaseAnswer();
  await expect(page.getByRole("button", { name: "聞き取りを再開" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.transcriptions[1].aborted)).toBe(true);
  await page.evaluate(() => (window as any).voiceTest.transcriptions[1].finish("利用上限後に届いた質問"));
  await say(page);
  await expect(page.getByText("利用上限後に届いた質問", { exact: true })).toHaveCount(0);
  expect(answers).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.transcriptions.length)).toBe(2);
});

test("入口はテキスト・音声・動画の3つで、音声の開始前にマイクを開かない", async ({ page }) => {
  await fakeAudio(page); await configure(page, false);
  await page.goto("/");
  // 入口は3つだけ。音声が無効でも選択肢は残し、開いた先で準備中を案内する。
  await expect(page.getByRole("group", { name: "面談の入口" }).getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /動画はこちら/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "テキストはこちら" })).toBeVisible();
  await expect(page.getByRole("link", { name: "音声はこちら" })).toBeVisible();
  // 以前の入口リンクは残さない。
  await expect(page.getByRole("link", { name: "声で話してみる" })).toHaveCount(0);
  await page.getByRole("link", { name: "音声はこちら" }).click();
  await expect(page.getByRole("heading", { name: "音声面談は準備中です" })).toBeVisible();
  await expect(page.getByRole("link", { name: "テキストで話す" })).toBeVisible();
  // 動画は押しても外部呼び出しもカメラ起動もしない。
  await page.goto("/");
  await page.getByRole("button", { name: /動画はこちら/ }).click({ force: true });
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(0);
  await configure(page, true);
  await page.goto("/");
  await page.getByRole("link", { name: "音声はこちら" }).click();
  await expect(page.getByText(/CloudflareとGoogleのGemini APIへ送り/)).toBeVisible();
  await expect(page.getByText("標準の合成音声", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(0);
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByText("マイク使用中", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(1);
});

test("テキストの入口は音声サービスの設定に依存しない", async ({ page }) => {
  await fakeAudio(page);
  // 音声の設定取得を失敗させても、テキストの会話は始められる。
  await page.route("**/api/voice/config", route => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await page.route("**/api/chat", route => route.fulfill({ contentType: "text/event-stream", body: [
    { type: "text", answerId: "text-entry", text: "テキストの回答です。" },
    { type: "done", answerId: "text-entry", answerability: "answerable", latencyMs: 1, firstTextMs: 1 },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") }));
  await page.goto("/");
  await page.getByRole("button", { name: "テキストはこちら" }).click();
  const input = page.getByRole("textbox", { name: "質問を入力" });
  await expect(input).toBeFocused();
  await input.fill("話せることは？");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("回答を準備しています…", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(0);
});

test("手動送信と発話終端でmono WAVを送り、再生完了した往復だけを履歴へ含める", async ({ page }, testInfo) => {
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
  await page.getByText("応答時間の内訳", { exact: true }).click();
  await expect(page.getByText("集計対象 1 往復", { exact: true })).toBeVisible();
  for (const label of ["発話終了待ち", "発話終了→文字確定", "検索・回答・通信", "音声化・通信", "再生待ち", "回答音声まで"])
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`voice-latency-${width}.png`), fullPage: true });
  }
  await say(page);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].history).toEqual([{ role: "user", content: "最初の質問です" }, { role: "assistant", content: "承認された情報からの回答です。" }]);
  await page.getByRole("button", { name: "面談を終了" }).click();
  await expect(page.getByText("最初の質問です", { exact: true })).toHaveCount(0);
  await expect(page.getByText("応答時間の内訳", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "もう一度はじめる" }).click();
  await page.getByText("応答時間の内訳", { exact: true }).click();
  await expect(page.getByText("集計対象 1 往復", { exact: true })).toHaveCount(0);
  await expect(page.getByText("計測できる回答はまだありません。回答の再生が完了すると表示します。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, stopped: (window as any).voiceTest.tracks.every((track: any) => track.stopped), closed: (window as any).voiceTest.contexts.every((context: any) => context.state === "closed") }))).toEqual({ local: 0, session: 0, stopped: true, closed: true });
});

test("音声のヒット率は再生完了後の文字にだけ付き、表示切替で音声や履歴を変えない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  const requests: any[] = [];
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "音声の質問です。" } }));
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    const id = `diagnostics-${requests.length}`;
    return route.fulfill({ contentType: "text/event-stream", body: sse([
      ...reply(id).slice(0, -1), { ...doneEvent(id), retrievalSimilarityPercent: requests.length === 1 ? 73 : null }
    ]) });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await begin(page);
  const toggle = page.getByRole("switch", { name: "回答のヒット率を表示" });
  const metrics = page.getByRole("log", { name: "音声の会話履歴" }).getByText(/（回答のヒット率:/);
  // 既定はオン。再生が終わるまでは指標を付けない。
  await expect(toggle).toBeChecked();
  await say(page);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await expect(metrics).toHaveCount(0);
  await expect(page.getByText("検索類似度の参考値です。正答率ではありません。", { exact: true })).toBeVisible();
  await finishAudio(page);
  await expect(metrics).toHaveText(["（回答のヒット率: 73%）"]);
  await expect(page.getByText("承認された情報からの回答です。", { exact: true })).toBeVisible();
  await toggle.click(); await expect(metrics).toHaveCount(0);
  await toggle.click(); await expect(metrics).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(1);
  // 設定した読み上げ速度が、再生へ渡す音源すべてに適用される。
  expect(await page.evaluate(() => (window as any).voiceTest.sources.map((source: any) => source.playbackRate.value)))
    .toEqual([config.playbackRate]);
  const samples = await page.evaluate(() => Array.from((window as any).voiceTest.sources[0].buffer.getChannelData(0)));
  expect(samples).toHaveLength(2400);
  expect(samples.every(value => Math.abs((value as number) - 3000 / 32768) < .000001)).toBe(true);
  await say(page);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].history).toEqual([{ role: "user", content: "音声の質問です。" }, { role: "assistant", content: "承認された情報からの回答です。" }]);
  expect(JSON.stringify(requests)).not.toContain("ヒット率");
  expect(JSON.stringify(requests)).not.toContain("retrievalSimilarityPercent");
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await finishAudio(page);
  await expect(metrics).toHaveText(["（回答のヒット率: 73%）", "（回答のヒット率: 算出対象外）"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  // 表示はメモリだけに置くため、再読み込みでは初期状態（オン）へ戻る。
  await page.reload(); await expect(toggle).toBeChecked();
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
  await page.getByText("応答時間の内訳", { exact: true }).click();
  await expect(page.getByText("計測できる回答はまだありません。回答の再生が完了すると表示します。", { exact: true })).toBeVisible();
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

test("画面を隠しても面談と会話は続き、明示停止とページ離脱で止められる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "テスト質問" } }));
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events), reply("stopped").slice(0, -1));
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await page.getByRole("button", { name: "回答を止める" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.requests[0].aborted)).toBe(true);
  await page.evaluate(event => (window as any).voiceTest.emit(0, [event], true), { ...doneEvent("stopped"), retrievalSimilarityPercent: 88 });
  await expect(page.getByRole("log", { name: "音声の会話履歴" }).getByText(/（回答のヒット率:/)).toHaveCount(0);
  await page.getByText("応答時間の内訳", { exact: true }).click();
  await expect(page.getByText("計測できる回答はまだありません。回答の再生が完了すると表示します。", { exact: true })).toBeVisible();
  await say(page); await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
  // 別のタブで調べ物をしても、面談もマイクもそのまま続く。
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  expect(await page.evaluate(() => ({
    vadListening: (window as any).voiceTest.vads.some((vad: any) => vad.listening),
    trackStopped: (window as any).voiceTest.tracks.some((track: any) => track.stopped),
    playbackSuspended: (window as any).voiceTest.contexts.some((context: any) => context.state === "suspended")
  }))).toEqual({ vadListening: true, trackStopped: false, playbackSuspended: false });
  await expect(page.getByRole("button", { name: "面談を終了" })).toBeVisible();
  await expect(page.getByText("テスト質問", { exact: true }).first()).toBeVisible();
  // 隠したままでも次の発話を送れる。
  await say(page); await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(3);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
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
  await expect(page.getByRole("button", { name: "聞き取りを再開" })).toBeVisible();
  await page.getByRole("button", { name: "聞き取りを再開" }).click();
  stage = "answer"; await say(page); await expect.poll(() => answers).toBe(1);
  await expect(alert).toHaveText("音声の利用回数の上限に達しました。時間をおいて、もう一度お試しください。");
  await expect(page.locator("body")).not.toContainText(privateDetail);
  await expect(page.getByRole("button", { name: "聞き取りを再開" })).toBeVisible();
  await say(page); expect(answers).toBe(1);
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

test("VADの読み込みに失敗したら自動送信せず、明示した手動録音だけを送る", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/vad/bundle.min.js", route => route.fulfill({ status: 503, contentType: "text/plain", body: "" }));
  const recordings: Buffer[] = [];
  await page.route("**/api/voice/transcribe", route => {
    recordings.push(route.request().postDataBuffer()!);
    return route.fulfill({ json: { text: "手動録音の質問です" } });
  });
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }));
  await begin(page);
  await expect(page.getByText("自動の聞き取りを利用できないため、録音ボタンでお話しください。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "録音を開始" })).toBeEnabled();
  await say(page); expect(recordings).toHaveLength(0);
  await page.getByRole("button", { name: "録音を開始" }).click();
  await page.evaluate(async () => { const state = (window as any).voiceTest; await state.capture(3); await state.capture(7, 0); });
  await expect(page.getByRole("heading", { name: "お話を聞いています" })).toBeVisible();
  expect(recordings).toHaveLength(0);
  await page.getByRole("button", { name: "発言を送る" }).click();
  await expect(page.getByText("手動録音の質問です", { exact: true })).toBeVisible();
  expect(recordings).toHaveLength(1);
  expect(wavView(recordings[0]).getUint32(24, true)).toBe(16_000);
  expect(recordings[0].byteLength).toBe(32_044);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await finishAudio(page);
  await expect(page.getByRole("button", { name: "録音を開始" })).toBeEnabled();
  await page.getByRole("button", { name: "面談を終了" }).click();
  expect(await page.evaluate(() => (window as any).voiceTest.tracks.every((track: any) => track.stopped))).toBe(true);
});

test("VAD推論の失敗後も回答を再生し、手動録音した相槌で再開できる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0, answers = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "経歴を教えてください" : "はい" } }));
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page); await say(page);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as any).voiceTest;
    state.vads.at(-1).failNextFrame = true;
    await state.capture(1);
  });
  await expect(page.getByRole("button", { name: "録音を開始" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("running");
  await say(page); expect(transcriptions).toBe(1);
  await page.getByRole("button", { name: "録音を開始" }).click();
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("suspended");
  await say(page, false);
  await expect(page.getByText("相槌を受け取り、回答を続けます。", { exact: true })).toBeVisible();
  expect(transcriptions).toBe(2); expect(answers).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("running");
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
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
  await expect(page.getByText("音声を準備中", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.allowMicrophone)).toBe("function");
  await page.getByRole("button", { name: "面談を終了" }).click();
  await page.evaluate(() => (window as any).voiceTest.allowMicrophone());
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.tracks[0]?.stopped)).toBe(true);
  await expect(page.getByText("マイク停止中", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.worklets.length)).toBe(0);
});

test("モデルの準備中にマイクが切れたら終了し、遅れた読み込みで面談を再開しない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let releaseBundle!: () => void, bundleRequested = false, apiCalls = 0;
  const heldBundle = new Promise<void>(resolve => { releaseBundle = resolve; });
  await page.route("**/vad/bundle.min.js", async route => {
    bundleRequested = true; await heldBundle;
    await route.fulfill({ contentType: "text/javascript", body: `(${installFakeVad.toString()})(); window.voiceTest.delayedVadScriptLoaded = true;` });
  });
  for (const endpoint of ["transcribe", "chat"])
    await page.route(`**/api/voice/${endpoint}`, route => { apiCalls++; return route.fulfill({ status: 503, body: "" }); });
  try {
    await page.goto("/voice");
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect.poll(() => bundleRequested).toBe(true);
    await expect(page.getByText("音声を準備中", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).voiceTest.tracks[0].readyState)).toBe("live");
    await page.evaluate(() => (window as any).voiceTest.tracks[0].end());
    await expect(page.getByRole("heading", { name: "おつかれさまでした" })).toBeVisible();
    await expect(page.getByText("マイクとの接続が切れたため終了しました。もう一度開始できます。", { exact: true })).toBeVisible();
    releaseBundle();
    await expect.poll(() => page.evaluate(() => (window as any).voiceTest.delayedVadScriptLoaded)).toBe(true);
    await expect(page.getByRole("heading", { name: "おつかれさまでした" })).toBeVisible();
    await expect(page.getByText("マイク停止中", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "録音を開始" })).toHaveCount(0);
    expect(await page.evaluate(() => {
      const state = (window as any).voiceTest;
      return { micCalls: state.micCalls, tracks: state.tracks.map((track: any) => track.readyState),
        contexts: state.contexts.map((context: any) => context.state), vads: state.vads.length, worklets: state.worklets.length };
    })).toEqual({ micCalls: 1, tracks: ["ended"], contexts: ["closed", "closed"], vads: 0, worklets: 0 });
    expect(apiCalls).toBe(0);
  } finally { releaseBundle(); }
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
  // 読み上げ速度のぶんだけ短い間隔で予約する。
  expect(sources[1].when).toBeCloseTo(sources[0].when + sources[0].duration / config.playbackRate, 6);
  await page.evaluate(() => (window as any).voiceTest.sources[0].finish());
  await expect(page.getByRole("button", { name: "回答を止める" })).toBeEnabled();
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

test("4秒PCMの大きいSSEを150KB超の途中位置で分断しても全音声と完了履歴を保つ", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "長い音声の質問です。" : "続きの質問です。" } }));
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);

  const answerId = "large-pcm", answerText = "分割された音声も最後まで再生します。";
  const firstPcm = Buffer.alloc(12_000), largePcm = Buffer.alloc(192_000);
  for (let offset = 0; offset < firstPcm.length; offset += 2) firstPcm.writeInt16LE(3000, offset);
  for (let offset = 0; offset < largePcm.length; offset += 2) largePcm.writeInt16LE((offset / 2 * 97) % 65_536 - 32_768, offset);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events), [
    { type: "start", answerId }, { type: "text", answerId, text: answerText }, { ...audioEvent(answerId), data: firstPcm.toString("base64") }
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(1);

  const frame = sse([{ ...audioEvent(answerId, 1), data: largePcm.toString("base64") }]);
  expect(frame.length).toBeGreaterThan(256_000);
  expect(frame.length).toBeLessThan(300_000);
  // 2片目を読んだ時点で未完のSSEが200,000文字になる。先頭250msの音だけは既に再生できる。
  for (const fragment of [frame.slice(0, 100_000), frame.slice(100_000, 200_000)])
    await page.evaluate(value => (window as any).voiceTest.streams[0].enqueue(new TextEncoder().encode(value)), fragment);
  expect(await page.evaluate(() => ({ sources: (window as any).voiceTest.sources.length, aborted: (window as any).voiceTest.requests[0].aborted })))
    .toEqual({ sources: 1, aborted: false });
  await page.evaluate(({ tail, done }) => {
    const state = (window as any).voiceTest;
    state.streams[0].enqueue(new TextEncoder().encode(tail)); state.emit(0, [done], true);
  }, { tail: frame.slice(200_000), done: doneEvent(answerId) });
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(2);
  expect(await page.evaluate(() => {
    const sources = (window as any).voiceTest.sources;
    const first: Float32Array = sources[0].buffer.getChannelData(0), large: Float32Array = sources[1].buffer.getChannelData(0);
    return { durations: sources.map((source: any) => source.buffer.duration), firstFrames: first.length, largeFrames: large.length,
      firstPcmMatches: first.every(value => value === 3000 / 32_768),
      largePcmMatches: large.every((value, index) => value === ((index * 97) % 65_536 - 32_768) / 32_768) };
  })).toEqual({ durations: [.25, 4], firstFrames: 6000, largeFrames: 96_000, firstPcmMatches: true, largePcmMatches: true });
  await page.evaluate(() => (window as any).voiceTest.sources[0].finish());
  await expect(page.getByRole("button", { name: "回答を止める" })).toBeEnabled();
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).voiceTest.requests[1].history)).toEqual([
    { role: "user", content: "長い音声の質問です。" }, { role: "assistant", content: answerText }
  ]);
  await page.getByRole("button", { name: "面談を終了" }).click();
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
    await expect(page.getByRole("log", { name: "音声の会話履歴" }).getByText(/（回答のヒット率:/)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).voiceTest.sources.every((source: any) => source.stopped))).toBe(true);
    await page.getByText("応答時間の内訳", { exact: true }).click();
    await expect(page.getByText("計測できる回答はまだありません。回答の再生が完了すると表示します。", { exact: true })).toBeVisible();
    await say(page); await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].history).toEqual([]);
  });
}

test("JEV障害は情報不足と区別し、未検証本文を出さず次の発言を受け付ける", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "強みは？" } }));
  let count = 0;
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: ++count === 1
    ? sse([{ type: "start", answerId: "failed-jev" }, { type: "error", code: "JEV_UNAVAILABLE", message: "untrusted-provider-detail" }])
    : sse(reply("recovered-jev")) }));
  await begin(page); await say(page);
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("回答の確認サービスに接続できませんでした");
  await expect(page.getByText("untrusted-provider-detail")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(0);
  await say(page); await expect(page.getByText("承認された情報からの回答です。", { exact: true })).toBeVisible();
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

for (const greeting of ["こんにちはー", "今日は", "あ、こんにちは。よろしくお願いします。"]) {
test(`ごく短い打鍵の連続を送らず、挨拶「${greeting}」への応答待ちでも確認しますを挟まない`, async ({ page }) => {
  await fakeAudio(page); await configure(page); await page.clock.install();
  let transcriptions = 0, fillers = 0;
  await page.route("**/api/voice/transcribe", route => { transcriptions++; return route.fulfill({ json: { text: greeting } }); });
  await page.route("**/audio/checking.wav", route => { fillers++; return route.fulfill({ status: 404 }); });
  await begin(page); await page.evaluate(async () => {
    const state = (window as any).voiceTest; state.live = true;
    for (let i = 0; i < 20; i++) {
      await state.tap();
      await state.capture(1, 0);
    }
  });
  await page.clock.fastForward(2000);
  expect(transcriptions).toBe(0); expect(fillers).toBe(0);
  await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.clock.fastForward(2000);
  expect(transcriptions).toBe(1); expect(fillers).toBe(0);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events, true), reply("hello", "こんにちは。気になることを聞いてください。"));
  await expect(page.getByText("こんにちは。気になることを聞いてください。", { exact: true })).toBeVisible();
});
}

test("文字起こしの通信失敗が2回続いたら自動送信を止め、ボタンから再開できる", async ({ page }, testInfo) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0, fillers = 0, answers = 0;
  await page.route("**/api/voice/transcribe", route => ++transcriptions <= 2 ? route.fulfill({ status: 503 }) : route.fulfill({ json: { text: "再開後の質問" } }));
  await page.route("**/audio/checking.wav", route => { fillers++; return route.fulfill({ status: 404 }); });
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page); await say(page);
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("音声を聞き取れませんでした");
  await say(page);
  await expect(page.getByRole("button", { name: "聞き取りを再開" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "聞き取りを一時停止しています" })).toBeVisible();
  await expect(page.getByText("聞き取りをいったん止めました。再開ボタンを押してからお話しください。", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("voice-listening-paused.png"), fullPage: true });
  for (let i = 0; i < 5; i++) await say(page);
  expect(transcriptions).toBe(2); expect(fillers).toBe(0); expect(answers).toBe(0);
  await page.getByRole("button", { name: "聞き取りを再開" }).click();
  await say(page); await expect(page.getByText("再開後の質問", { exact: true })).toBeVisible();
  expect(transcriptions).toBe(3); expect(answers).toBe(1);
});

test("発言なしの正常結果ではエラーも回答も出さず、次の声を受け付ける", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0, answers = 0, fillers = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions <= 3 ? transcriptions === 2 ? "…。！" : "" : "次の質問" } }));
  await page.route("**/audio/checking.wav", route => { fillers++; return route.fulfill({ status: 404 }); });
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page);
  for (let i = 1; i <= 3; i++) {
    await say(page); await expect.poll(() => transcriptions).toBe(i);
    await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
    await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "聞き取りを再開" })).toHaveCount(0);
  }
  expect(answers).toBe(0); expect(fillers).toBe(0);
  await say(page); await expect(page.getByText("次の質問", { exact: true })).toBeVisible();
  expect(answers).toBe(1);
});

test("AI発話中の発言なしは旧回答を再開し、新しい質問やエラーにしない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0, answers = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "質問です" : "" } }));
  await page.route("**/api/voice/chat", route => { answers++; return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await begin(page); await say(page);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await say(page); await expect.poll(() => transcriptions).toBe(2);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toHaveCount(0);
  expect(answers).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.contexts[1].state)).toBe("running");
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

test("文字起こしが中断に応じなくても時間内に復帰し、遅れた結果を捨てる", async ({ page }) => {
  await fakeAudio(page); await configure(page); await page.clock.install();
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "再試行の質問" } }));
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }));
  await begin(page); await page.evaluate(() => {
    const state = (window as any).voiceTest, original = window.fetch;
    window.fetch = (url, options) => {
      if (url === "/api/voice/transcribe" && !state.heldTranscription) {
        state.heldTranscription = true;
        return new Promise(resolve => { state.releaseTranscription = () => resolve(new Response(JSON.stringify({ text: "古い発言" }))); });
      }
      return original(url, options);
    };
  });
  await say(page);
  await expect(page.getByRole("heading", { name: "お話を確かめています" })).toBeVisible();
  await page.clock.fastForward(45_001);
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("音声を聞き取れませんでした");
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await say(page); await expect(page.getByText("再試行の質問", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).voiceTest.releaseTranscription());
  await expect(page.getByText("古い発言", { exact: true })).toHaveCount(0);
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

test("相槌の再生再開待ち中に面談を終了したら、遅れた処理で画面を戻さない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let transcriptions = 0;
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: ++transcriptions === 1 ? "経歴を教えて" : "はい" } }));
  await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }));
  await begin(page); await say(page);
  await expect(page.getByRole("heading", { name: "AIがお話ししています" })).toBeVisible();
  await page.evaluate(() => { (window as any).voiceTest.delayNextResume = true; });
  await say(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.releaseResume)).toBe("function");
  await page.getByRole("button", { name: "面談を終了" }).click();
  await page.evaluate(() => (window as any).voiceTest.releaseResume());
  await expect(page.getByRole("heading", { name: "おつかれさまでした" })).toBeVisible();
  await expect(page.getByText("相槌を受け取り、回答を続けます。", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log", { name: "音声の会話履歴" })).toHaveCount(0);
});

test("回答ストリームが止まってもタイムアウトで戻り、次の質問を受け付ける", async ({ page }) => {
  await fakeAudio(page); await configure(page); await page.clock.install();
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "質問です" } }));
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await page.clock.fastForward(90_001);
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toContainText("回答を続けられませんでした");
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.requests[0].cancelled)).toBe(true);
  await say(page);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(2);
  await page.evaluate(events => (window as any).voiceTest.emit(1, events, true), reply("recovered"));
  await expect(page.getByText("承認された情報からの回答です。", { exact: true })).toBeVisible();
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
});

test("補助音声は文字起こし完了後に1回だけ流れ、回答音声が届いたら停止する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let fillerCalls = 0;
  let release: (() => void) | undefined;
  await page.route("**/audio/checking.wav", route => { fillerCalls++; return route.fulfill({ contentType: "audio/wav", body: Buffer.from("mock-only") }); });
  await page.route("**/api/voice/transcribe", async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: { text: "少し待つ質問" } }); });
  await begin(page); await page.evaluate(() => { (window as any).voiceTest.live = true; }); await say(page);
  await expect(page.getByRole("heading", { name: "お話を確かめています" })).toBeVisible();
  await page.waitForTimeout(1100);
  expect(fillerCalls).toBe(0);
  await expect(page.getByText(/声が届くまで/)).toHaveCount(0);
  await page.getByText("応答時間の内訳", { exact: true }).click();
  await expect(page.getByText("計測できる回答はまだありません。回答の再生が完了すると表示します。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(0);
  release!();
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests.length)).toBe(1);
  await expect.poll(() => fillerCalls).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.sources.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.sources[0].stopped)).toBe(false);
  await page.evaluate(events => (window as any).voiceTest.emit(0, events, true), reply());
  await expect(page.getByText(/声が届くまで/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.sources[0].stopped)).toBe(true);
  expect(fillerCalls).toBe(1);
  await expect(page.getByText("集計対象 1 往復", { exact: true })).toHaveCount(0);
  await finishAudio(page);
  await expect(page.getByText("集計対象 1 往復", { exact: true })).toBeVisible();
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
    const diagnostics = page.locator(".answer-diagnostics");
    // 既定はオン。開いた状態でのはみ出しと、切り替えても高さが変わらないことを確認する。
    await expect(page.getByText("検索類似度の参考値です。正答率ではありません。", { exact: true })).toBeVisible();
    const before = await diagnostics.boundingBox();
    await page.getByRole("switch", { name: "回答のヒット率を表示" }).click();
    await expect(page.getByText("検索類似度の参考値です。正答率ではありません。", { exact: true })).toHaveCount(0);
    await page.getByRole("switch", { name: "回答のヒット率を表示" }).click();
    await expect(page.getByText("検索類似度の参考値です。正答率ではありません。", { exact: true })).toBeVisible();
    if (width === 1440) expect((await diagnostics.boundingBox())!.height).toBe(before!.height);
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
      return route.fulfill({ json: { text: "確認します。" } });
    });
    await page.route("**/api/voice/chat", route => route.fulfill({ contentType: "text/event-stream", body: sse(reply("native")) }));
    const navigation = await page.goto(`${testInfo.project.use.baseURL ?? "http://127.0.0.1:3000"}/voice`);
    expect(navigation?.headers()["permissions-policy"]).toContain("microphone=(self)");
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect.poll(() => captured?.byteLength ?? 0, { timeout: 15_000 }).toBeGreaterThan(44);
    await expect(page.getByText("確認します。", { exact: true })).toBeVisible();
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

// 偽のWeb Speech API。available()の問い合わせ内容と、processLocallyの指定を確認できるようにする。
function installFakeRecognition(options: { local: string; cloud: string; installResult?: boolean }) {
  const state: any = (window as any).recognitionTest = { instances: [], available: [], installs: [] };
  class SpeechRecognition {
    lang = ""; continuous = false; interimResults = false; maxAlternatives = 1; processLocally = false;
    onresult: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() { state.instances.push(this); }
    static async available(value: any) {
      state.available.push(value);
      if (value.processLocally) return state.installs.length ? "available" : options.local;
      return options.cloud;
    }
    static async install(value: any) { state.installs.push(value); return options.installResult ?? true; }
    start() { state.started = (state.started ?? 0) + 1; }
    stop() { const instance = this; setTimeout(() => instance.onend?.(), 0); }
    abort() {}
  }
  (window as any).SpeechRecognition = SpeechRecognition;
}

// 端末内認識の結果を、テストから発話中・確定として流し込む。
async function recognize(page: Page, entries: { text: string; final: boolean }[]) {
  await page.evaluate(values => {
    const instance = (window as any).recognitionTest.instances.at(-1);
    instance.onresult?.({ resultIndex: 0, results: values.map(value =>
      Object.assign([{ transcript: value.text }], { isFinal: value.final, length: 1 })) });
  }, entries);
}

test("端末内の日本語認識が使えるときは端末内を既定にし、processLocallyを明示する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  await page.goto("/voice");
  await expect(page.getByRole("radio", { name: /この端末で文字にする/ })).toBeChecked();
  await expect(page.locator(".voice-recognition-item.selected .voice-recognition-location")).toHaveText("処理場所：端末内");
  await expect(page.getByText(/音声を外部へ送りません/)).toBeVisible();
  await begin(page);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  expect(await page.evaluate(() => (window as any).recognitionTest.available
    .some((value: any) => value.processLocally === true && value.langs.includes("ja-JP")))).toBe(true);
  expect(await page.evaluate(() => {
    const instance = (window as any).recognitionTest.instances.at(-1);
    return { lang: instance.lang, continuous: instance.continuous, interimResults: instance.interimResults, processLocally: instance.processLocally };
  })).toEqual({ lang: "ja-JP", continuous: true, interimResults: true, processLocally: true });
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("端末内認識は途中結果を表示するだけで、確定まで回答APIを呼ばず、確定後に一度だけ送る", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply("local", "端末内で認識した質問への回答です。")) });
  });
  await begin(page);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await recognize(page, [{ text: "チームでの", final: false }]);
  await expect(page.getByText("まだ送信していません")).toBeVisible();
  expect(requests.length).toBe(0);
  await recognize(page, [{ text: "チームでの", final: true }, { text: "担当範囲はどこですか", final: true }]);
  expect(requests.length).toBe(0);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("チームでの担当範囲はどこですか");
  await expect(page.getByText("チームでの担当範囲はどこですか")).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("端末内認識で続けて話した2回目も、古い発話IDで失敗せず送れる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) });
  });
  await begin(page);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await recognize(page, [{ text: "最初の質問です", final: true }]);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("最初の質問です");
  await finishAudio(page);
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  // 続けて話す。前の発話IDが残っていると認識器が作り直されず、失敗の案内だけが出る。
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await recognize(page, [{ text: "次の質問です", final: true }]);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].message).toBe("次の質問です");
  await expect(page.getByRole("region", { name: "音声AI面談" }).getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("確定後に古い発話の認識結果が届いても、表示も送信もしない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply("stale")) });
  });
  await begin(page);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await recognize(page, [{ text: "最初の質問です", final: true }]);
  await page.evaluate(() => { (window as any).recognitionTest.stale = (window as any).recognitionTest.instances.at(-1).onresult; });
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect.poll(() => requests.length).toBe(1);
  await page.evaluate(() => (window as any).recognitionTest.stale({ resultIndex: 0,
    results: [{ 0: { transcript: "遅れて届いた文言" }, isFinal: true, length: 1 }] }));
  await expect(page.getByText("遅れて届いた文言")).toHaveCount(0);
  expect(requests.length).toBe(1);
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("端末内認識で自動の聞き分けが使えないときは、発言を送るボタンで確定する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  // VADのモデルを読み込めない端末を再現する。
  await page.route("**/vad/bundle.min.js", route => route.fulfill({ status: 404, body: "" }));
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply("manual-send")) });
  });
  await begin(page);
  await expect(page.getByText(/「発言を送る」を押してください/).first()).toBeVisible();
  await recognize(page, [{ text: "ボタンで送る質問です", final: true }]);
  expect(requests.length).toBe(0);
  await page.getByRole("button", { name: "発言を送る" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("ボタンで送る質問です");
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("端末内が使えないときは従来の方式を既定にし、音声を外部へ送ることを明示する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "unavailable", cloud: "available" });
  await page.goto("/voice");
  await expect(page.getByRole("radio", { name: /このアプリの音声認識を使う/ })).toBeChecked();
  // 音声の文字起こしが外部サービスで行われることを明示する。
  await expect(page.getByText(/音声の文字起こしはgeminiで行います/i)).toBeVisible();
  await expect(page.getByText(/CloudflareとGoogleのGemini APIへ送り/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /手入力で質問する/ })).toBeVisible();
});

test("端末内の言語パックが未導入のときは案内してから追加し、追加後に端末内を選べる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "downloadable", cloud: "available" });
  await page.goto("/voice");
  await expect(page.getByText(/言語パックの追加ダウンロードが必要です/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /この端末で文字にする/ })).toHaveCount(0);
  await page.getByRole("button", { name: "日本語の言語パックを追加する" }).click();
  // processLocallyを渡さないとChromeは何もせずfalseを返すため、指定を確認する。
  expect(await page.evaluate(() => (window as any).recognitionTest.installs)).toEqual([{ langs: ["ja-JP"], processLocally: true }]);
  await expect(page.getByText("言語パックを追加しました")).toBeVisible();
  await expect(page.getByRole("radio", { name: /この端末で文字にする/ })).toBeChecked();
});

test("手入力を選ぶとマイクを開かず、入力した文字だけを一度送る", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "unavailable", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply("typed")) });
  });
  await page.goto("/voice");
  await page.getByRole("radio", { name: /手入力で質問する/ }).check();
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(0);
  await page.getByLabel("質問を入力").fill("担当範囲を教えてください");
  await page.locator("form.voice-typed").getByRole("button", { name: "送る" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("担当範囲を教えてください");
  await expect(page.getByText("担当範囲を教えてください")).toBeVisible();
});

test("認識方式が使えないと分かったら、完了扱いにせず理由を示して選び直させる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "unavailable", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: "text/event-stream", body: sse(reply()) }); });
  await page.goto("/voice");
  await page.getByRole("radio", { name: /ブラウザーの音声認識を使う/ }).check();
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  // 埋め込みブラウザーなどで認識サービスへ接続できない場合。
  await page.evaluate(() => (window as any).recognitionTest.instances.at(-1).onerror({ error: "network" }));
  await expect(page.getByText("音声認識の接続が切れました。通信を確認し、別の方式も選べます。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "音声を開始できませんでした" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "おつかれさまでした" })).toHaveCount(0);
  // 失敗した方式も選び直せる。既定だけ別の方式へ移す。
  await expect(page.getByRole("radio", { name: /ブラウザーの音声認識を使う/ })).toBeEnabled();
  await expect(page.getByRole("radio", { name: /このアプリの音声認識を使う/ })).toBeChecked();
  await page.getByRole("radio", { name: /ブラウザーの音声認識を使う/ }).check();
  await expect(page.getByRole("radio", { name: /ブラウザーの音声認識を使う/ })).toBeChecked();
  expect(requests.length).toBe(0);
});

test("言語パックを追加できないブラウザーでは、別の方法へ案内する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "downloadable", cloud: "available", installResult: false });
  await page.goto("/voice");
  await page.getByRole("button", { name: "日本語の言語パックを追加する" }).click();
  await expect(page.getByText(/このブラウザーでは追加できない場合があります/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /このアプリの音声認識を使う/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /この端末で文字にする/ })).toHaveCount(0);
});

test("言語パックの準備中は、その状態を示して確認できる", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "downloading", cloud: "available" });
  await page.goto("/voice");
  await expect(page.getByText(/言語パックを準備しています/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /この端末で文字にする/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /このアプリの音声認識を使う/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "準備できたか確認する" })).toBeVisible();
});

test("待機中から認識エンジンを動かし、発話の頭から文字にする", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.addInitScript(installFakeRecognition, { local: "available", cloud: "available" });
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: "text/event-stream", body: sse(reply("onset")) }); });
  await begin(page);
  // 発話を検知する前から、認識エンジンは動いている。
  expect(await page.evaluate(() => { const state = (window as any).recognitionTest; return { count: state.instances.length, started: state.started ?? 0 }; }))
    .toEqual({ count: 1, started: 1 });
  await page.evaluate(async () => { await (window as any).voiceTest.capture(3); });
  await recognize(page, [{ text: "自己紹介お願いします", final: true }]);
  await page.evaluate(async () => { await (window as any).voiceTest.capture(13, 0); });
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("自己紹介お願いします");
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("使用中のマイク名を表示する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.goto("/voice");
  await begin(page);
  // 許可の後に取れるトラックのlabelを、処理場所とは別に示す。
  await expect(page.getByText("マイク：MacBook Airのマイク").first()).toBeVisible();
  await page.getByRole("button", { name: "面談を終了" }).click();
});

test("回答APIが失敗したら理由を示し、繰り返す場合は再読み込みを案内する", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "テスト質問" } }));
  let calls = 0;
  await page.route("**/api/voice/chat", route => { calls++; return route.fulfill({ status: 503, body: "" }); });
  await begin(page);
  await say(page);
  await expect(page.getByText(/回答を作れませんでした/)).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  // 失敗しても聞き取りは続き、もう一度話せる。
  await expect(page.getByRole("button", { name: "面談を終了" })).toBeVisible();
  await say(page); await expect.poll(() => calls).toBe(2);
  await expect(page.getByText(/画面を再読み込みしてください/)).toBeVisible();
});

test("同じ会話で手入力と音声入力を続けられ、発話の設定は入力方法で変わらない", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  const requests: any[] = [];
  await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: "最初の質問です" } }));
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply(`turn-${requests.length}`)) });
  });
  await page.goto("/voice");
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  // 1: 音声入力。
  await say(page);
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText("承認された情報からの回答です。")).toBeVisible();
  const send = page.locator("form.voice-typed").getByRole("button", { name: "送る" });
  // 読み上げと回答の確定を待つ。読み上げ中は「回答を止める」が押せる。
  await settle(page);
  // 2: 同じ会話のまま、手入力で続ける。発話の設定は切り替えで変わらない。
  await page.getByLabel("質問を入力").fill("手入力の質問です");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].message).toBe("手入力の質問です");
  expect(requests[1].speak).toBe(true);
  expect(requests[1].history).toEqual([{ role: "user", content: "最初の質問です" },
    { role: "assistant", content: "承認された情報からの回答です。" }]);
  await settle(page);
  // 3: 読み上げをオフにすると、その設定のまま回答の文字は残る。
  await page.getByRole("checkbox", { name: /AIの読み上げ/ }).uncheck();
  await page.getByLabel("質問を入力").fill("読み上げなしの質問です");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].speak).toBe(false);
  await expect(page.getByText("承認された情報からの回答です。").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "面談を終了" })).toBeVisible();
});

test("マイクを拒否されても、同じ画面の文字入力で会話を続けられる", async ({ page }) => {
  await fakeAudio(page, true); await configure(page);
  const requests: any[] = [];
  await page.route("**/api/voice/chat", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: sse(reply("denied", "文字入力の回答です。")) });
  });
  await page.goto("/voice");
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByText(/マイクを使用できませんでした/)).toBeVisible();
  await page.getByRole("button", { name: "マイクを使わず文字入力で続ける" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.micCalls)).toBe(1);
  await page.getByLabel("質問を入力").fill("マイクなしの質問です");
  await page.locator("form.voice-typed").getByRole("button", { name: "送る" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].message).toBe("マイクなしの質問です");
  await expect(page.getByText("文字入力の回答です。")).toBeVisible();
});

test("回答の準備中は、文字画面と同じ文言を出す", async ({ page }) => {
  await fakeAudio(page); await configure(page);
  let release: (() => void) | undefined;
  await page.route("**/api/voice/chat", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ contentType: "text/event-stream", body: sse(reply("waiting")) });
  });
  await page.goto("/voice");
  await page.getByRole("button", { name: "音声面談をはじめる" }).click();
  await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
  await page.getByLabel("質問を入力").fill("待つ質問です");
  await page.locator("form.voice-typed").getByRole("button", { name: "送る" }).click();
  await expect(page.getByRole("log", { name: "音声の会話履歴" }).getByText("回答を準備しています…", { exact: true })).toBeVisible();
  release!();
  await expect(page.getByText("承認された情報からの回答です。")).toBeVisible();
});
