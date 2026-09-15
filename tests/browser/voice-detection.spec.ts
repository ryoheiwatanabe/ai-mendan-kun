import { test, expect, chromium, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const sampleRate = 24_000;
const wavView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const config = { enabled: true, processors: "GoogleのGemini API", speechProvider: "gemini", voiceName: "Kore", maxRecordingSeconds: 30, maxAudioBytes: 3_200_044 };

async function pcmFile(path: URL): Promise<Float32Array> {
  const source = await readFile(path);
  const sourceView = wavView(source);
  expect(source.subarray(0, 4).toString()).toBe("RIFF");
  expect(source.subarray(8, 12).toString()).toBe("WAVE");
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= source.length;) {
    const name = source.subarray(at, at + 4).toString(), size = sourceView.getUint32(at + 4, true);
    if (name === "fmt ") {
      expect(sourceView.getUint16(at + 8, true)).toBe(1);
      expect(sourceView.getUint16(at + 10, true)).toBe(1);
      expect(sourceView.getUint32(at + 12, true)).toBe(sampleRate);
      expect(sourceView.getUint16(at + 22, true)).toBe(16);
    }
    if (name === "data") data = source.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  expect(data).toBeDefined();
  const dataView = wavView(data!);
  return Float32Array.from({ length: data!.length / 2 }, (_, index) => dataView.getInt16(index * 2, true) / 32768);
}

function wave(parts: Float32Array[]): Buffer {
  const frames = parts.reduce((sum, part) => sum + part.length, 0), output = Buffer.alloc(44 + frames * 2);
  output.write("RIFF"); output.writeUInt32LE(output.length - 8, 4); output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34); output.write("data", 36); output.writeUInt32LE(frames * 2, 40);
  let at = 44;
  for (const part of parts) for (const value of part) { output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), at); at += 2; }
  return output;
}
const silence = (seconds: number) => new Float32Array(Math.round(seconds * sampleRate));

// 固定波形の回帰用fixture。実際の環境音・打鍵録音の検出精度とは区別する。
function noise(seconds: number, keyboard: boolean): Float32Array {
  let seed = 0x5eed;
  return Float32Array.from({ length: seconds * sampleRate }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const random = seed / 0x80000000 - 1;
    if (!keyboard) return random * .25 + Math.sin(index / sampleRate * Math.PI * 240) * .04;
    const phase = index % Math.round(sampleRate * .17), decay = Math.exp(-phase / (sampleRate * .008));
    return (random * .75 + Math.sin(phase / sampleRate * Math.PI * 1800) * .15) * decay;
  });
}

async function observeNativeAudio(page: Page) {
  await page.addInitScript(() => {
    const state: any = { streams: [], contexts: [], worklets: [], micAt: 0 };
    (window as any).nativeVadTest = state;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints); state.micAt ||= performance.now(); state.streams.push(stream); return stream;
    };
    window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
      const context = Reflect.construct(target, args); state.contexts.push(context); return context;
    } });
    window.AudioWorkletNode = new Proxy(window.AudioWorkletNode, { construct(target, args) {
      const node = Reflect.construct(target, args);
      const observed = { name: args[1], samples: 0, rate: args[1] === "vad-helper-worklet" ? 16_000 : args[0].sampleRate, maxRms: 0 };
      state.worklets.push(observed);
      node.port.addEventListener("message", (event: MessageEvent) => {
        const frame = event.data instanceof Float32Array ? event.data
          : event.data?.data instanceof ArrayBuffer ? new Float32Array(event.data.data) : null;
        if (!frame?.length) return;
        observed.samples += frame.length;
        observed.maxRms = Math.max(observed.maxRms, Math.sqrt(frame.reduce((sum: number, value: number) => sum + value * value, 0) / frame.length));
      });
      return node;
    } });
  });
}

const cases = [
  { name: "無音・高RMSの人工環境雑音・打鍵で送信せず、続く公開合成声で送信する", file: "../../public/audio/checking.wav", text: "確認します。", negatives: true },
  { name: "短い合成音声「はい」を発話として送信する", file: "../fixtures/audio/hai-kyoko.wav", text: "はい", negatives: false },
  { name: "短い合成音声「うん」を発話として送信する", file: "../fixtures/audio/un-kyoko.wav", text: "うん", negatives: false }
];

for (const scenario of cases) test(`実SileroとネイティブWorkletは${scenario.name}`, async ({}, testInfo) => {
  test.setTimeout(45_000);
  const speech = await pcmFile(new URL(scenario.file, import.meta.url));
  const beforeSpeech = scenario.negatives ? [silence(2), noise(2, false), silence(.8), noise(2, true), silence(.8)] : [silence(2)];
  const speechStartsAt = beforeSpeech.reduce((sum, part) => sum + part.length / sampleRate, 0);
  const parts = [...beforeSpeech, speech, silence(2)], duration = parts.reduce((sum, part) => sum + part.length / sampleRate, 0);
  const fixture = testInfo.outputPath("synthetic-microphone.wav");
  await writeFile(fixture, wave(parts));
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: [
    "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}%noloop`, "--use-fake-ui-for-media-stream", "--mute-audio"
  ] });
  let page: Page | undefined;
  try {
    const baseURL = String(testInfo.project.use.baseURL ?? "http://127.0.0.1:3100"), origin = new URL(baseURL).origin;
    const context = await browser.newContext(); page = await context.newPage();
    const externalRequests: string[] = [], assets = new Set<string>(), recordings: Buffer[] = [];
    let answers = 0;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.origin); return route.abort(); }
      return route.continue();
    });
    page.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/vad/") && response.status() === 200) assets.add(path);
    });
    await observeNativeAudio(page);
    await page.route("**/api/voice/config", route => route.fulfill({ json: config }));
    await page.route("**/audio/checking.wav", route => route.fulfill({ status: 404 }));
    await page.route("**/api/voice/transcribe", async route => {
      const elapsed = await page!.evaluate(() => (performance.now() - (window as any).nativeVadTest.micAt) / 1000);
      expect(elapsed).toBeGreaterThanOrEqual(speechStartsAt - .2);
      recordings.push(route.request().postDataBuffer()!);
      await route.fulfill({ json: { text: scenario.text } });
    });
    await page.route("**/api/voice/chat", route => {
      answers++;
      const id = "synthetic-vad-test";
      const events = [{ type: "start", answerId: id }, { type: "text", answerId: id, text: "合成音声を受信しました。" },
        { type: "audio", answerId: id, sequence: 0, data: Buffer.alloc(4800).toString("base64"), mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
        { type: "done", answerId: id, answerability: "answerable", latencyMs: 1, firstTextMs: 1 }];
      return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    });
    await page.goto(`${baseURL}/voice`);
    await page.getByRole("button", { name: "音声面談をはじめる" }).click();
    await expect.poll(() => recordings.length, { timeout: 25_000 }).toBe(1);
    await expect(page.getByText("合成音声を受信しました。", { exact: true })).toBeVisible();
    await expect.poll(() => page!.evaluate(() => Math.max(0, ...(window as any).nativeVadTest.worklets.map((node: any) => node.samples / node.rate))), { timeout: 15_000 }).toBeGreaterThan(duration);
    expect(recordings).toHaveLength(1); expect(answers).toBe(1);
    const recording = recordings[0];
    expect(recording.subarray(0, 4).toString()).toBe("RIFF");
    const recordingView = wavView(recording);
    expect(recordingView.getUint16(22, true)).toBe(1); expect(recordingView.getUint32(24, true)).toBe(16_000); expect(recordingView.getUint16(34, true)).toBe(16);
    expect(assets.has("/vad/silero_vad_v5.onnx")).toBe(true);
    expect(assets.has("/vad/ort-wasm-simd-threaded.wasm")).toBe(true);
    expect(externalRequests).toEqual([]);
    if (scenario.negatives) expect(await page.evaluate(() => Math.max(...(window as any).nativeVadTest.worklets.map((node: any) => node.maxRms)))).toBeGreaterThan(.08);
    await expect(page.getByRole("heading", { name: "どうぞ、お話しください" })).toBeVisible();
    await page.getByRole("button", { name: "面談を終了" }).click();
    await expect.poll(() => page!.evaluate(() => ({
      tracksEnded: (window as any).nativeVadTest.streams.flatMap((stream: MediaStream) => stream.getTracks()).every((track: MediaStreamTrack) => track.readyState === "ended"),
      contextsClosed: (window as any).nativeVadTest.contexts.every((context: AudioContext) => context.state === "closed"),
      workletObserved: (window as any).nativeVadTest.worklets.some((node: any) => node.name === "vad-helper-worklet" && node.samples > 0),
      storedItems: localStorage.length + sessionStorage.length
    }))).toEqual({ tracksEnded: true, contextsClosed: true, workletObserved: true, storedItems: 0 });
  } finally {
    try {
      if (page && !page.isClosed()) {
        const metrics = await page.evaluate(() => ({ worklets: (window as any).nativeVadTest?.worklets }));
        await writeFile(testInfo.outputPath("detection-metrics.json"), JSON.stringify(metrics, null, 2));
      }
    } finally { await browser.close(); }
  }
});
