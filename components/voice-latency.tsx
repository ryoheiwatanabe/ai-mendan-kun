import { summarizeLatency, type AnswerLatency, type VoiceLatency } from "../lib/voice/latency.ts";

const seconds = (milliseconds: number) => (milliseconds / 1000).toFixed(2) + " 秒";

// 応答時間の内訳は、文字と音声で同じ部品を使う。音声だけの区間は、文字では行ごと出さない。
export function LatencyDetails({ mode, samples, setupMs = null, recognition = null }: {
  mode: "voice" | "text"; samples: AnswerLatency[]; setupMs?: number | null; recognition?: string | null;
}) {
  const voice = mode === "voice";
  const latest = samples.at(-1);
  const summary = summarizeLatency(samples);

  return <details className="voice-latency">
    <summary>応答時間の内訳</summary>
    {voice && recognition && <p className="voice-latency-label">音声認識：{recognition}{setupMs === null ? "" : "（初回の準備 " + seconds(setupMs) + "）"}</p>}
    {latest && summary ? <>
      <p className="voice-latency-label">直近の計測できた回答</p>
      <dl className="voice-latency-values">
        {voice && <div><dt>発話終了待ち</dt><dd>{seconds(latest.endpointMs ?? 0)}</dd></div>}
        {voice && <div><dt>発話終了→文字確定</dt><dd>{seconds(latest.transcriptionMs ?? 0)}</dd></div>}
        <div><dt>検索・回答・通信</dt><dd>{seconds(latest.answerMs)}</dd></div>
        {voice && <div><dt>音声化・通信</dt><dd>{latest.speechMs === null ? "読み上げなし" : seconds(latest.speechMs)}</dd></div>}
        {voice && <div><dt>再生待ち</dt><dd>{latest.playbackMs === null ? "読み上げなし" : seconds(latest.playbackMs)}</dd></div>}
        <div className="voice-latency-total"><dt>{voice && latest.speechMs !== null ? "回答音声まで" : "回答表示まで"}</dt><dd>{seconds(latest.totalMs)}</dd></div>
      </dl>
      <p className="voice-latency-label">集計対象 {summary.count} 往復</p>
      <dl className="voice-latency-values">
        <div><dt>P50</dt><dd>{seconds(summary.p50Ms)}</dd></div>
        <div><dt>P95</dt><dd>{seconds(summary.p95Ms)}</dd></div>
      </dl>
    </> : <p className="voice-latency-note">計測できる回答はまだありません。{voice ? "回答の再生が完了すると表示します。" : "回答の表示が完了すると表示します。"}</p>}
    <p className="voice-latency-note">{voice
      ? "ブラウザー推定の参考値です。通信・承認確認を含み、補助音声は除きます。"
      : "ブラウザー推定の参考値です。通信・承認確認を含みます。"}</p>
    <p className="voice-latency-note">{voice ? "アプリが途中発話を検出した回答、中断・失敗した回答は集計しません。少数試行のP95は参考値です。"
      : "中断・失敗した回答は集計しません。少数試行のP95は参考値です。"}</p>
  </details>;
}

// 音声画面の呼び出し口（既存の名前を維持する）。
export function VoiceLatencyDetails({ samples, setupMs = null, recognition = null }: {
  samples: VoiceLatency[]; setupMs?: number | null; recognition?: string | null;
}) {
  return <LatencyDetails mode="voice" samples={samples} setupMs={setupMs} recognition={recognition} />;
}

// 文字画面の呼び出し口。
export function TextLatencyDetails({ samples }: { samples: AnswerLatency[] }) {
  return <LatencyDetails mode="text" samples={samples} />;
}

