// 同じブラウザーのperformance時計で計測。API区間は通信・承認確認も含む。
export type VoiceTimingMarks = {
  endedAt: number;
  submittedAt: number;
  transcribedAt: number;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  playedAt: number | null;
};
export type VoiceLatency = {
  endpointMs: number;
  transcriptionMs: number;
  answerMs: number;
  // 読み上げなしの設定では、音声化と再生の区間は観測できない。
  speechMs: number | null;
  playbackMs: number | null;
  totalMs: number;
};

export function measureVoiceLatency(marks: VoiceTimingMarks, speak = true): VoiceLatency | null {
  const points = speak
    ? [marks.endedAt, marks.submittedAt, marks.transcribedAt, marks.firstTextAt, marks.firstAudioAt, marks.playedAt]
    : [marks.endedAt, marks.submittedAt, marks.transcribedAt, marks.firstTextAt];
  if (points.some((point, index) => point === null || !Number.isFinite(point) || point < 0
    || index > 0 && point < points[index - 1]!)) return null;
  const [end, submit, transcribe, text] = points as number[];
  const shared = { endpointMs: Math.round(submit - end), transcriptionMs: Math.round(transcribe - submit), answerMs: Math.round(text - transcribe) };
  if (!speak) {
    // 読み上げなし: 回答本文が出るまでの区間だけを測る。
    return { ...shared, speechMs: null, playbackMs: null, totalMs: Math.round(text - end) };
  }
  const [, , , , audio, play] = points as number[];
  return { ...shared, speechMs: Math.round(audio - text), playbackMs: Math.round(play - audio), totalMs: Math.round(play - end) };
}

// nearest-rank。入力はこのセッションで再生まで完了した、途中発話のない往復だけ。
export function summarizeVoiceLatency(samples: VoiceLatency[]): { count: number; p50Ms: number; p95Ms: number } | null {
  const totals = samples.map(sample => sample.totalMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!totals.length) return null;
  return { count: totals.length, p50Ms: totals[Math.ceil(totals.length * .5) - 1], p95Ms: totals[Math.ceil(totals.length * .95) - 1] };
}
