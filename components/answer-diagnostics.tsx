"use client";

import { useId, useState } from "react";
import type { ConversationMessage } from "../lib/conversation.ts";
import { conversationLabels } from "../lib/conversation.ts";
import type { AnswerLatency } from "../lib/voice/latency.ts";
import type { AnswerMetrics } from "../lib/answer/metrics.ts";
import { LatencyDetails } from "./voice-latency";

type DiagnosticMessage = Pick<ConversationMessage, "id" | "role" | "complete" | "retrievalSimilarityPercent" | "metrics"> & { latency?: AnswerLatency };

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
        <summary>回答ごとの詳細</summary>
        {answers.length ? <div className="answer-hit-rates">
          {answers.map((message, index) => <details className="answer-metrics" key={message.id}>
            <summary><span>回答 {index + 1}</span><span>ヒット率 <span className="answer-hit-rate-value">{hitRate(message.retrievalSimilarityPercent)}</span></span></summary>
            {message.metrics ? <AnswerMetricsDetails metrics={message.metrics} />
              : <p className="voice-latency-note">この回答の処理情報は取得できませんでした。</p>}
          </details>)}
        </div> : <p className="voice-latency-note">完了した回答はまだありません。</p>}
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

const duration = (milliseconds: number | null) => milliseconds === null ? "未取得" : `${(milliseconds / 1000).toFixed(2)} 秒`;
const tokens = (usage: AnswerMetrics["jev"] | AnswerMetrics["generation"]) => usage.inputTokens === null || usage.outputTokens === null
  ? "未取得" : `入力 ${usage.inputTokens.toLocaleString("ja-JP")} / 出力 ${usage.outputTokens.toLocaleString("ja-JP")}`;

function AnswerMetricsDetails({ metrics: { jev, generation, retrieval } }: { metrics: AnswerMetrics }) {
  return <>
    <dl className="voice-latency-values">
      <div><dt>JEV呼び出し</dt><dd>{jev.calls} 回（失敗 {jev.failed} 回を含む）</dd></div>
      <div><dt>音声入力の補正</dt><dd>{jev.byPurpose.input_normalization ?? 0} 回</dd></div>
      <div><dt>根拠の選別 / 候補の絞り込み</dt><dd>{jev.byPurpose.scope} / {jev.byPurpose.screening} 回</dd></div>
      <div><dt>複数案の比較 / 回答の点検</dt><dd>{jev.byPurpose.routes} / {jev.byPurpose.verification} 回</dd></div>
      <div><dt>JEV処理時間（合計）</dt><dd>{duration(jev.milliseconds)}</dd></div>
      <div><dt>回答生成 / うち修正</dt><dd>{generation.calls} / {generation.repairs} 回</dd></div>
      <div><dt>生成時間（完了分 {generation.completed} 回）</dt><dd>{duration(generation.milliseconds)}</dd></div>
      <div><dt>初回検索の候補 / 採用</dt><dd>{retrieval.candidates ?? "対象外"} / {retrieval.adopted ?? "対象外"} 件</dd></div>
      <div><dt>初回検索の時間</dt><dd>{duration(retrieval.milliseconds)}</dd></div>
      <div className="diagnostics-device"><dt>JEVトークン（取得 {jev.usageCalls}/{jev.calls} 回）</dt><dd>{tokens(jev)}</dd></div>
      <div className="diagnostics-device"><dt>生成トークン（取得 {generation.usageCalls}/{generation.calls} 回）</dt><dd>{tokens(generation)}</dd></div>
    </dl>
    <p className="voice-latency-note">JEVは再試行を含む通信回数です。トークンは取得できた分だけの合計で、課金額を表すものではありません。</p>
  </>;
}
