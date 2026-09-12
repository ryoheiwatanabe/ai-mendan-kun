import { summarizeVoiceLatency, type VoiceLatency } from "../lib/voice/latency.ts";

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)} 秒`;

export function VoiceLatencyDetails({ samples }: { samples: VoiceLatency[] }) {
  const latest = samples.at(-1);
  const summary = summarizeVoiceLatency(samples);

  return <details className="voice-latency">
    <summary>応答時間の内訳</summary>
    {latest && summary ? <>
      <p className="voice-latency-label">直近の計測できた回答</p>
      <dl className="voice-latency-values">
        <div><dt>発話終了待ち</dt><dd>{seconds(latest.endpointMs)}</dd></div>
        <div><dt>音声認識・通信</dt><dd>{seconds(latest.transcriptionMs)}</dd></div>
        <div><dt>検索・回答・通信</dt><dd>{seconds(latest.answerMs)}</dd></div>
        <div><dt>音声化・通信</dt><dd>{seconds(latest.speechMs)}</dd></div>
        <div><dt>再生待ち</dt><dd>{seconds(latest.playbackMs)}</dd></div>
        <div className="voice-latency-total"><dt>回答音声まで</dt><dd>{seconds(latest.totalMs)}</dd></div>
      </dl>
      <p className="voice-latency-label">集計対象 {summary.count} 往復</p>
      <dl className="voice-latency-values">
        <div><dt>P50</dt><dd>{seconds(summary.p50Ms)}</dd></div>
        <div><dt>P95</dt><dd>{seconds(summary.p95Ms)}</dd></div>
      </dl>
    </> : <p className="voice-latency-note">計測できる回答はまだありません。回答の再生が完了すると表示します。</p>}
    <p className="voice-latency-note">ブラウザー推定の参考値です。通信・承認確認を含み、補助音声は除きます。</p>
    <p className="voice-latency-note">アプリが途中発話を検出した回答、中断・失敗した回答は集計しません。少数試行のP95は参考値です。</p>
  </details>;
}
