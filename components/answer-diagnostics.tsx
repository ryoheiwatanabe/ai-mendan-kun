"use client";

import { useId, useState } from "react";
import type { ConversationMessage } from "../lib/conversation.ts";
import { conversationLabels } from "../lib/conversation.ts";
import type { AnswerLatency } from "../lib/voice/latency.ts";
import { LatencyDetails } from "./voice-latency";

type DiagnosticMessage = Pick<ConversationMessage, "id" | "role" | "complete" | "retrievalSimilarityPercent"> & { latency?: AnswerLatency };

const hitRate = (percent?: number | null) => typeof percent === "number" && Number.isFinite(percent)
  && percent >= 0 && percent <= 100 ? `${percent}%` : "算出対象外";

// 会話本文に計測値を混ぜず、文字・音声とも同じフッターで確認する。
export function ConversationDiagnostics({ mode, messages, setupMs = null, recognition = null, ttfaMs = null, microphone = null, failureDetail = "" }: {
  mode: "text" | "voice"; messages: DiagnosticMessage[]; setupMs?: number | null; recognition?: string | null;
  ttfaMs?: number | null; microphone?: string | null; failureDetail?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const panelId = useId();
  const answers = messages.filter(message => message.role === "assistant" && message.complete);

  return <footer className="developer-footer" aria-label="開発者向けの計測">
    <div className="answer-diagnostics">
      <button type="button" role="switch" aria-checked={enabled} aria-controls={enabled ? panelId : undefined}
        className="answer-diagnostics-switch" onClick={() => setEnabled(value => !value)}>
        <span className="answer-diagnostics-track" aria-hidden="true"><span /></span>
        <span>開発者モード<span className="developer-switch-note">（応答速度等が表示されます）</span></span>
      </button>
    </div>
    {enabled && <div id={panelId}>
      <LatencyDetails mode={mode} samples={answers.flatMap(message => message.latency ? [message.latency] : [])}
        setupMs={setupMs} recognition={recognition} />
      <details className="voice-latency" open>
        <summary>回答のヒット率</summary>
        {answers.length ? <dl className="voice-latency-values answer-hit-rates">
          {answers.map((message, index) => <div key={message.id}><dt>回答 {index + 1}</dt><dd>{hitRate(message.retrievalSimilarityPercent)}</dd></div>)}
        </dl> : <p className="voice-latency-note">完了した回答はまだありません。</p>}
        <p className="voice-latency-note">検索類似度の参考値です。正答率ではありません。</p>
      </details>
      {mode === "voice" && (ttfaMs !== null || microphone) && <div className="voice-latency">
        <dl className="voice-latency-values">
          {ttfaMs !== null && <div><dt>声が届くまで</dt><dd>{(ttfaMs / 1000).toFixed(1)} 秒</dd></div>}
          {microphone && <div className="diagnostics-device"><dt>マイク</dt><dd>{microphone}</dd></div>}
        </dl>
      </div>}
      {failureDetail && <p className="voice-latency error-detail">{conversationLabels.failureStage}{failureDetail}</p>}
    </div>}
  </footer>;
}
