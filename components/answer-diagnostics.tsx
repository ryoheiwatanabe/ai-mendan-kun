import { useId } from "react";

export function AnswerDiagnosticsSwitch({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const noteId = useId();

  return <div className="answer-diagnostics">
    <button type="button" role="switch" aria-checked={enabled} aria-describedby={enabled ? noteId : undefined} className="answer-diagnostics-switch" onClick={() => onChange(!enabled)}>
      <span className="answer-diagnostics-track" aria-hidden="true"><span /></span>
      <span>回答のヒット率を表示</span>
    </button>
    {enabled && <p id={noteId}>検索類似度の参考値です。正答率ではありません。</p>}
  </div>;
}

export function AnswerDiagnosticsValue({ percent }: { percent?: number | null }) {
  const value = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? `${percent}%` : "算出対象外";
  return <small className="answer-diagnostics-value">（回答のヒット率: {value}）</small>;
}
