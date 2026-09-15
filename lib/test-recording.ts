// 開発用loopback proxyだけに接続する。公開版の会話や外部APIへは送信しない。
export type TestRecordingStatus = { enabled: boolean; healthy: boolean };
let current: TestRecordingStatus = { enabled: false, healthy: true };
let pending: Promise<TestRecordingStatus> | null = null;
let sessionId: string | null = null;
let clientFailed = false;
const changed = "ai-mendan-test-recording-status";
const local = () => typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location.hostname);
const session = () => sessionId ??= crypto.randomUUID();

function update(value: TestRecordingStatus) {
  if (current.enabled && !value.enabled) value = { enabled: true, healthy: false };
  if (value.enabled && !value.healthy) clientFailed = true;
  if (value.enabled && clientFailed) value = { enabled: true, healthy: false };
  current = value;
  window.dispatchEvent(new Event(changed));
  return value;
}

export function testRecordingStatus(refresh = false): Promise<TestRecordingStatus> {
  if (!local()) return Promise.resolve(current);
  if (pending && !refresh) return pending;
  pending = fetch("/__test-recording/status", { cache: "no-store", signal: AbortSignal.timeout(2000) })
    .then(async response => {
      if (response.status === 404) return update({ enabled: false, healthy: true });
      if (!response.ok) throw new Error("recording_unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("enabled" in value) || value.enabled !== true
        || !("healthy" in value) || typeof value.healthy !== "boolean") throw new Error("recording_status_invalid");
      return update({ enabled: true, healthy: value.healthy });
    }).catch(() => update({ enabled: true, healthy: false }));
  return pending;
}

export function observeTestRecording(listener: (value: TestRecordingStatus) => void): () => void {
  if (!local()) { listener(current); return () => {}; }
  const notify = () => listener(current);
  window.addEventListener(changed, notify);
  void testRecordingStatus().then(notify);
  const timer = setInterval(() => { if (current.enabled) void testRecordingStatus(true); }, 5000);
  return () => { window.removeEventListener(changed, notify); clearInterval(timer); };
}

// UUIDはこのタブのメモリだけに置き、複数タブの会話を分ける。
export async function recordingFetch(input: string, init: RequestInit): Promise<Response> {
  if (!local()) return fetch(input, init);
  const status = await testRecordingStatus();
  if (!status.enabled) return fetch(input, init);
  if (!current.healthy) throw new Error("検証記録を保存できません。接続と保存先を確認してください。");
  const headers = new Headers(init.headers);
  headers.set("x-test-recording-session", session());
  return fetch(input, { ...init, headers });
}

function failed() { if (local() && current.enabled) { clientFailed = true; update({ enabled: true, healthy: false }); } }

// 検証記録を続けられない状態を画面へ伝える。面談そのものは止めない。
export function markTestRecordingFailed() { failed(); }

export function recordTestEvent(type: string, data: Record<string, unknown>, leaving = false) {
  if (!local() || !current.enabled) return;
  const body = JSON.stringify({ sessionId: session(), type, at: new Date().toISOString(), data });
  void fetch("/__test-recording/events", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: leaving })
    .then(async response => { await response.arrayBuffer(); if (!response.ok) failed(); }).catch(failed);
}

// VADで捨てられた声も検証できるよう、面談開始〜終了のマイクを別途ローカル保存する。
export async function startTestMicrophoneCapture(stream: MediaStream, onFailure: () => void): Promise<{ stop(): void } | null> {
  const status = await testRecordingStatus();
  if (!status.enabled) return null;
  if (!current.healthy || typeof MediaRecorder === "undefined") { failed(); throw new Error("test_recording_unavailable"); }
  const captureId = crypto.randomUUID(), id = session();
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find(value => MediaRecorder.isTypeSupported(value));
  if (!mimeType) { failed(); throw new Error("test_recording_unsupported"); }
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
  let count = 0, stopping = false;
  const failure = () => { failed(); if (!stopping) { stopping = true; if (recorder.state !== "inactive") recorder.stop(); onFailure(); } };
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    const sequence = count++;
    const query = new URLSearchParams({ session: id, capture: captureId, sequence: String(sequence) });
    // keepaliveの容量枠は小さいため、通常収録には使わない。終了時の末尾だけを対象にする。
    void fetch(`/__test-recording/microphone?${query}`, { method: "POST", body: event.data, keepalive: stopping && document.visibilityState === "hidden" })
      .then(async response => { await response.arrayBuffer(); if (!response.ok) failure(); }).catch(failure);
  };
  recorder.onerror = failure;
  recorder.onstop = () => {
    recordTestEvent("microphone-stop", { captureId, chunks: count });
    // partの到着順には依存せず、proxyが全連番の保存を確認してから結合する。
    void fetch("/__test-recording/microphone-end", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ sessionId: id, captureId, count, mimeType: recorder.mimeType }) })
      .then(async response => { await response.arrayBuffer(); if (!response.ok) failed(); }).catch(failed);
  };
  recorder.start(1000);
  recordTestEvent("microphone-start", { captureId, mimeType: recorder.mimeType });
  return { stop() {
    if (stopping) return;
    stopping = true;
    // pagehide後のonstopは実行されないことがあるため、取得済みpartの回収指示を先に送る。
    recordTestEvent("microphone-stop-requested", { captureId, count, mimeType: recorder.mimeType }, true);
    if (recorder.state !== "inactive") recorder.stop();
  } };
}
