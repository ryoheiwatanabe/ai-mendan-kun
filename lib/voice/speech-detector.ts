import type { MicVAD } from "@ricky0123/vad-web";

type VadLibrary = { MicVAD: typeof MicVAD };
type VadResources = { model: { release(): Promise<void> }; _vadNode?: AudioWorkletNode };
type EndReason = "silence" | "manual" | "limit";
type Callbacks = {
  start(): void;
  end(audio: Float32Array, endedAt: number, reason: EndReason): void;
  failure(): void;
};
let library: Promise<VadLibrary> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (error?: Error) => {
      clearTimeout(timeout); script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("vad_load_timeout")), 15_000);
    script.src = src; script.async = true;
    script.onload = () => finish(); script.onerror = () => finish(new Error("vad_load_failed"));
    document.head.appendChild(script);
  });
}

async function loadLibrary() {
  if (!library) library = (async () => {
    await loadScript("/vad/ort.wasm.min.js");
    await loadScript("/vad/bundle.min.js");
    const value = (window as Window & { vad?: VadLibrary }).vad;
    if (!value?.MicVAD) throw new Error("vad_unavailable");
    return value;
  })().catch(error => { library = null; throw error; });
  return library;
}

// MicVAD 0.0.30のdestroyは初期化前にthrowするため、その場合もモデルを解放する。
async function releaseVad(vad: MicVAD) {
  const resources = vad as unknown as VadResources;
  try { await vad.destroy(); }
  catch { await resources.model.release(); }
  finally {
    const node = resources._vadNode;
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.close(); node.disconnect(); }
  }
}

/** 推論とpause/resetを直列化し、停止前のフレームを次の発言へ持ち越さない。 */
export class SpeechDetector {
  private vad: MicVAD | null = null;
  private enabled = false;
  private closed = false;
  private ready = false;
  private epoch = 0;
  private processingEpoch: number | null = null;
  private pending = 0;
  private work: Promise<void> = Promise.resolve();
  private segmentSamples = 0;
  private confirmed = false;
  private endedAt = 0;
  private flushing: Exclude<EndReason, "silence"> | null = null;

  private callbacks: Callbacks;
  private maxSeconds: number;
  private remainingSamples: number;
  constructor(callbacks: Callbacks, maxSeconds: number) {
    this.callbacks = callbacks; this.maxSeconds = maxSeconds; this.remainingSamples = Math.floor(16_000 * maxSeconds);
  }

  async start(context: AudioContext, stream: MediaStream, signal: AbortSignal) {
    const { MicVAD } = await loadLibrary();
    signal.throwIfAborted();
    const vad = await MicVAD.new({
      model: "v5", audioContext: context, getStream: async () => stream,
      pauseStream: async () => {}, resumeStream: async () => stream,
      startOnLoad: false, processorType: "AudioWorklet",
      baseAssetPath: "/vad/", onnxWASMBasePath: "/vad/",
      positiveSpeechThreshold: .3, negativeSpeechThreshold: .25,
      minSpeechMs: 96, redemptionMs: 1216, preSpeechPadMs: 256,
      submitUserSpeechOnPause: false,
      ortConfig: ort => { ort.env.logLevel = "error"; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
      onSpeechStart: () => { if (this.accepting()) { this.segmentSamples = 4096; this.confirmed = false; } },
      onSpeechRealStart: () => { if (this.accepting()) { this.confirmed = true; this.callbacks.start(); } },
      onVADMisfire: () => { this.segmentSamples = 0; this.confirmed = false; },
      onSpeechEnd: audio => {
        this.segmentSamples = 0; this.confirmed = false;
        if (!this.closed && (this.accepting() || this.flushing))
          this.callbacks.end(audio, this.endedAt, this.flushing ?? (audio.length >= this.remainingSamples ? "limit" : "silence"));
      },
      onFrameProcessed: (probabilities, frame) => {
        if (!this.accepting()) return;
        if (this.segmentSamples) this.segmentSamples += frame.length;
        if (probabilities.isSpeech >= .3) this.endedAt = performance.now();
      }
    });
    this.vad = vad;
    if (signal.aborted || this.closed) { this.closed = true; await releaseVad(vad); this.vad = null; return; }
    const process = vad.processFrame;
    vad.processFrame = frame => {
      if (!this.enabled || this.closed) return Promise.resolve();
      // 遅い端末でも録音フレームを無制限に待ち行列へ溜めない。
      if (this.pending >= 8) { this.fail(); return Promise.resolve(); }
      const epoch = this.epoch; this.pending++;
      this.work = this.work.then(async () => {
        if (!this.enabled || this.closed || epoch !== this.epoch) return;
        this.processingEpoch = epoch;
        try { await process(frame); } finally { this.processingEpoch = null; }
        // ライブラリが当該フレームを区間へ取り込んだ後でflushする。
        if (this.enabled) {
          if (this.confirmed && this.segmentSamples >= this.remainingSamples) this.flush("limit");
          else if (this.segmentSamples >= 16_000 * this.maxSeconds) { this.setEnabled(false); this.setEnabled(true); }
        }
      }).catch(() => this.fail()).finally(() => { this.pending--; });
      return this.work;
    };
    try {
      signal.throwIfAborted();
      await vad.start();
      if (signal.aborted || this.closed) { this.closed = true; await releaseVad(vad); this.vad = null; return; }
      // 0.0.30にはWorkletエラー用の公開callbackがないため、固定版のnodeへ接続する。
      const node = (vad as unknown as VadResources)._vadNode;
      if (node) node.onprocessorerror = () => this.fail();
      this.ready = true; this.enabled = true;
    } catch (error) { this.closed = true; await releaseVad(vad); this.vad = null; throw error; }
  }

  private accepting() { return !this.closed && this.enabled && this.processingEpoch === this.epoch; }

  setEnabled(enabled: boolean) {
    if (this.closed || !this.ready || !this.vad || enabled === this.enabled) return;
    this.enabled = enabled; this.epoch++; this.segmentSamples = 0; this.confirmed = false;
    const vad = this.vad;
    this.work = this.work.then(async () => {
      if (this.closed) return;
      if (enabled) await vad.start(); else await vad.pause();
    }).catch(() => this.fail());
  }

  // 続けて話した区間も、同じ発言の録音上限に収める。
  setRemainingSamples(samples: number) {
    this.remainingSamples = Math.max(0, Math.min(Math.floor(16_000 * this.maxSeconds), Math.floor(samples)));
  }

  flush(reason: Exclude<EndReason, "silence"> = "manual") {
    if (!this.enabled || this.closed || !this.vad) return;
    this.enabled = false; this.epoch++; this.flushing = reason;
    const vad = this.vad;
    this.work = this.work.then(async () => {
      if (this.closed) return;
      vad.setOptions({ submitUserSpeechOnPause: true });
      try { await vad.pause(); }
      finally { this.flushing = null; vad.setOptions({ submitUserSpeechOnPause: false }); }
    }).catch(() => this.fail());
  }

  private fail() {
    if (this.closed) return;
    this.close(); this.callbacks.failure();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.enabled = false; this.epoch++;
    const vad = this.vad;
    // 推論完了後に解放する。ロード中ならstart側で遅れて得たモデルを解放する。
    if (vad && this.ready) this.work = this.work.then(() => releaseVad(vad)).catch(() => {});
  }
}
