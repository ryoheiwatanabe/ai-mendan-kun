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
  speechMs: number;
  playbackMs: number;
  totalMs: number;
};

export function measureVoiceLatency(marks: VoiceTimingMarks): VoiceLatency | null {
  const points = [marks.endedAt, marks.submittedAt, marks.transcribedAt, marks.firstTextAt, marks.firstAudioAt, marks.playedAt];
  if (points.some((point, index) => point === null || !Number.isFinite(point) || point < 0
    || index > 0 && point < points[index - 1]!)) return null;
  const [end, submit, transcribe, text, audio, play] = points as number[];
  return { endpointMs: Math.round(submit - end), transcriptionMs: Math.round(transcribe - submit),
    answerMs: Math.round(text - transcribe), speechMs: Math.round(audio - text), playbackMs: Math.round(play - audio),
    totalMs: Math.round(play - end) };
}

// nearest-rank。入力はこのセッションで再生まで完了した、途中発話のない往復だけ。
export function summarizeVoiceLatency(samples: VoiceLatency[]): { count: number; p50Ms: number; p95Ms: number } | null {
  const totals = samples.map(sample => sample.totalMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!totals.length) return null;
  return { count: totals.length, p50Ms: totals[Math.ceil(totals.length * .5) - 1], p95Ms: totals[Math.ceil(totals.length * .95) - 1] };
}
