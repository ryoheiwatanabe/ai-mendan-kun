import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SpeechDetector } from "../lib/voice/speech-detector.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const instances: FakeVad[] = [];
let modelGate: ReturnType<typeof deferred> | null = null;
let startGate: ReturnType<typeof deferred> | null = null;

// 判定精度は実モデルのブラウザテストで扱い、ここでは遅い推論・初期化を再現する。
class FakeVad {
  listening = false;
  initialized = false;
  processing = false;
  releases = 0;
  frames: Float32Array[] = [];
  inferenceGate: ReturnType<typeof deferred> | null = null;
  endOnFrame = false;
  confirm = true;
  _vadNode = { onprocessorerror: null as (() => void) | null, port: { onmessage: null, close() {} }, disconnect() {} };
  model = { release: async () => { assert.equal(this.processing, false); this.releases++; } };
  options: any;
  constructor(options: any) { this.options = options; instances.push(this); }
  static async new(options: any) {
    const vad = new FakeVad(options);
    await modelGate?.promise;
    return vad;
  }
  start = async () => { await startGate?.promise; this.initialized = true; this.listening = true; };
  pause = async () => {
    assert.equal(this.processing, false, "pause must wait for inference");
    this.listening = false;
    await this.options.pauseStream();
    if (this.options.submitUserSpeechOnPause && this.frames.length) this.end();
    this.frames = [];
  };
  destroy = async () => {
    if (!this.initialized) throw new Error("not_initialized");
    await this.pause(); await this.model.release();
  };
  setOptions = (options: any) => { Object.assign(this.options, options); };
  private end() {
    const audio = new Float32Array(this.frames.length * 512);
    this.frames.forEach((frame, index) => audio.set(frame, index * 512));
    this.frames = []; this.options.onSpeechEnd(audio);
  }
  processFrame = async (frame: Float32Array) => {
    this.processing = true;
    await this.inferenceGate?.promise;
    // MicVAD 0.0.30同様、awaitの後にpause状態を再確認しない。
    this.options.onFrameProcessed({ isSpeech: .95 }, frame);
    if (!this.frames.length) { this.options.onSpeechStart(); if (this.confirm) this.options.onSpeechRealStart(); }
    this.frames.push(frame);
    if (this.endOnFrame) this.end();
    this.processing = false;
  };
}

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "window", { configurable: true, value: { vad: { MicVAD: FakeVad } } });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  createElement: () => ({ onload: null, onerror: null, remove() {} }),
  head: { appendChild: (script: any) => { queueMicrotask(() => script.onload?.()); } }
} });
after(() => {
  if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
});

function fixture(maxSeconds = 30) {
  const events: string[] = [], recordings: Float32Array[] = [];
  const detector = new SpeechDetector({ start: () => events.push("start"), end: audio => { events.push("end"); recordings.push(audio); }, failure: () => events.push("failure") }, maxSeconds);
  const controller = new AbortController();
  const start = () => detector.start({} as AudioContext, {} as MediaStream, controller.signal);
  return { detector, events, recordings, controller, start };
}
const frame = () => new Float32Array(512).fill(.1);

test("モデル読込中に終了しても、遅れて得たモデルを一度だけ解放する", async () => {
  const f = fixture(); modelGate = deferred();
  const loading = f.start(); await tick();
  const vad = instances.at(-1)!;
  f.controller.abort(); f.detector.close();
  modelGate.resolve(); await loading; modelGate = null; await tick();
  assert.equal(vad.releases, 1); assert.equal(vad.initialized, false); assert.deepEqual(f.events, []);
});

test("Worklet初期化中の終了は初期化完了までモデルを解放しない", async () => {
  const f = fixture(); startGate = deferred();
  const loading = f.start(); await tick();
  const vad = instances.at(-1)!;
  f.detector.close(); await tick(); assert.equal(vad.releases, 0);
  startGate.resolve(); await loading; startGate = null; await tick();
  assert.equal(vad.releases, 1); assert.deepEqual(f.events, []);
});

test("推論待ちで停止・再開しても古いフレームを通知せず、次の区間を新しく始める", async () => {
  const f = fixture(); await f.start(); const vad = instances.at(-1)!;
  vad.inferenceGate = deferred();
  const processing = vad.processFrame(frame()); await tick();
  f.detector.setEnabled(false); f.detector.setEnabled(true);
  vad.inferenceGate.resolve(); await processing; vad.inferenceGate = null; await tick();
  assert.deepEqual(f.events, []); assert.deepEqual(vad.frames, []);
  await vad.processFrame(frame()); assert.deepEqual(f.events, ["start"]);
  f.detector.close(); await tick(); assert.equal(vad.releases, 1);
});

test("手動送信と自然終端が同時でも最後のフレームを含めて一度だけ送信する", async () => {
  const f = fixture(); await f.start(); const vad = instances.at(-1)!;
  await vad.processFrame(frame());
  vad.inferenceGate = deferred(); vad.endOnFrame = true;
  const processing = vad.processFrame(frame()); await tick(); f.detector.flush();
  vad.inferenceGate.resolve(); await processing; await tick();
  assert.deepEqual(f.events, ["start", "end"]); assert.equal(f.recordings[0].length, 1024);
  f.detector.close(); await tick();
});

test("手動送信は進行中の推論を待ってから区間を確定する", async () => {
  const f = fixture(); await f.start(); const vad = instances.at(-1)!;
  await vad.processFrame(frame()); vad.inferenceGate = deferred();
  const processing = vad.processFrame(frame()); await tick(); f.detector.flush();
  vad.inferenceGate.resolve(); await processing; await tick();
  assert.deepEqual(f.events, ["start", "end"]); assert.equal(f.recordings[0].length, 1024);
  f.detector.setEnabled(true); await tick(); vad.inferenceGate = null;
  await vad.processFrame(frame()); assert.deepEqual(f.events, ["start", "end", "start"]);
  f.detector.close(); await tick();
});

test("発話上限では最後のフレーム取込み後に区切り、内部バッファを空にする", async () => {
  const f = fixture(.5); await f.start(); const vad = instances.at(-1)!;
  for (let index = 0; index < 20; index++) await vad.processFrame(frame());
  await tick(); assert.deepEqual(f.events, ["start", "end"]);
  assert.ok(f.recordings[0].length > 0); assert.ok(f.recordings[0].length <= 8000);
  assert.deepEqual(vad.frames, []); assert.equal(vad.listening, false);
  f.detector.close(); await tick();
});

test("推論中に終了するとイベントを破棄し、推論完了後に解放する", async () => {
  const f = fixture(); await f.start(); const vad = instances.at(-1)!;
  vad.inferenceGate = deferred(); vad.endOnFrame = true;
  const processing = vad.processFrame(frame()); await tick(); f.detector.close();
  assert.equal(vad.releases, 0);
  vad.inferenceGate.resolve(); await processing; await tick();
  assert.deepEqual(f.events, []); assert.equal(vad.releases, 1);
});

test("Workletの故障は一度だけ通知し、その後の自動録音を受け付けない", async () => {
  const f = fixture(); await f.start(); const vad = instances.at(-1)!;
  const failure = vad._vadNode.onprocessorerror!;
  failure(); failure(); await vad.processFrame(frame()); await tick();
  assert.deepEqual(f.events, ["failure"]); assert.equal(vad.releases, 1);
  assert.equal(vad._vadNode.onprocessorerror, null);
});

test("長い未確定音は上限で捨てて聞き取りを続け、API用区間を作らない", async () => {
  const f = fixture(.5); await f.start(); const vad = instances.at(-1)!; vad.confirm = false;
  for (let index = 0; index < 20; index++) await vad.processFrame(frame());
  await tick(); assert.deepEqual(f.events, []); assert.equal(vad.listening, true);
  f.detector.setEnabled(false); f.detector.setEnabled(true); await tick(); vad.confirm = true;
  await vad.processFrame(frame()); assert.deepEqual(f.events, ["start"]);
  f.detector.close(); await tick();
});
