import test from "node:test";
import assert from "node:assert/strict";
import { measureVoiceLatency, summarizeVoiceLatency, type VoiceTimingMarks } from "../lib/voice/latency.ts";

const marks: VoiceTimingMarks = { endedAt: 100, submittedAt: 800, transcribedAt: 3200, firstTextAt: 5800, firstAudioAt: 7600, playedAt: 7620 };
test("音声の待ち時間は同じ時計の境界から計測し、通信込みの5区間へ分ける", () => {
  assert.deepEqual(measureVoiceLatency(marks), { endpointMs: 700, transcriptionMs: 2400, answerMs: 2600, speechMs: 1800, playbackMs: 20, totalMs: 7520 });
  assert.equal(measureVoiceLatency({ ...marks, submittedAt: marks.endedAt })?.endpointMs, 0, "手動送信に無音待ちを足さない");
});
test("未観測・非数・時計の逆転を0秒の成功として表示しない", () => {
  for (const field of ["firstTextAt", "firstAudioAt", "playedAt"] as const) assert.equal(measureVoiceLatency({ ...marks, [field]: null }), null);
  for (const field of Object.keys(marks)) {
    assert.equal(measureVoiceLatency({ ...marks, [field]: NaN }), null);
    assert.equal(measureVoiceLatency({ ...marks, [field]: Infinity }), null);
    assert.equal(measureVoiceLatency({ ...marks, [field]: -1 }), null);
  }
  assert.equal(measureVoiceLatency({ ...marks, playedAt: 7599 }), null);
});
test("完了往復のP50・P95をnearest-rankで算出し、少数・空集合も区別する", () => {
  const sample = measureVoiceLatency(marks)!;
  assert.equal(summarizeVoiceLatency([]), null);
  assert.deepEqual(summarizeVoiceLatency([sample]), { count: 1, p50Ms: 7520, p95Ms: 7520 });
  const samples = Array.from({ length: 20 }, (_, index) => ({ ...sample, totalMs: (20 - index) * 100 }));
  assert.deepEqual(summarizeVoiceLatency(samples), { count: 20, p50Ms: 1000, p95Ms: 1900 });
  assert.equal(samples[0].totalMs, 2000, "元の時系列を並べ替えない");
});
