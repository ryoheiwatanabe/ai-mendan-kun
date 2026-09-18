"use client";

import { useState } from "react";
import { jevQuestionIds, type JevAxis } from "../lib/ai/jev.ts";
import { jevCeilings, jevTreatments, type JevAxisTreatment, type JevSettings } from "../lib/answer/jev-settings.ts";

const axisLabels: Record<JevAxis, string> = {
  target_match: "対象一致", aspect_match: "項目一致", claims_supported: "根拠支持",
  no_invented_causality: "因果の非創作", no_scope_expansion: "範囲の保持", no_unnecessary_abstention: "不要な棄権の回避"
};
const treatmentLabels: Record<JevAxisTreatment, string> = { required: "必須", optional: "任意", record: "記録のみ" };
const treatmentNotes: Record<JevAxisTreatment, string> = {
  required: "1つでも不合格なら不採用", optional: "不合格の件数に数える", record: "採否に使わない"
};

type StoredSettings = { version: number; createdAt: string; settings: JevSettings | null; invalid: boolean };
type Payload = { current: StoredSettings | null; previous: StoredSettings | null; defaults: JevSettings;
  ceilings: typeof jevCeilings; note?: string; error?: { code?: string; message?: string } };

export function JevSettingsPanel() {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState<JevSettings | null>(null);
  const [server, setServer] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function request(method: "GET" | "POST", body?: unknown): Promise<Payload | null> {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/jev-settings", { method, cache: "no-store",
        headers: method === "GET" ? { "x-mendan-admin": token }
          : { "Content-Type": "application/json", "x-mendan-admin": token },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => null) as Payload | null;
      if (!response.ok) { setError(data?.error?.message ?? `処理できませんでした（${response.status}）。`); return null; }
      return data;
    } catch {
      setError("接続できませんでした。時間をおいてお試しください。"); return null;
    } finally { setBusy(false); }
  }

  function accept(data: Payload, message: string) {
    setServer(data); setDraft(data.current?.settings ?? data.defaults);
    setNotice(data.current?.invalid ? "保存済みの設定を読み取れなかったため、初期値を表示しています。保存し直すと直ります。" : message);
  }

  async function load() { const data = await request("GET"); if (data) accept(data, ""); }
  async function send(action: string, message: string) {
    const data = await request("POST", action === "save" && draft ? { action, settings: draft } : { action });
    if (data) accept(data, message);
  }
  function editAxis(axis: JevAxis, change: { threshold?: number; treatment?: JevAxisTreatment }) {
    setDraft(current => current ? { ...current, axes: { ...current.axes, [axis]: { ...current.axes[axis], ...change } } } : current);
  }
  function editNumber(change: Partial<JevSettings["limits"] & JevSettings["budgets"]> & { optionalFailureLimit?: number }) {
    setDraft(current => current ? { ...current, ...change,
      limits: { ...current.limits, ...("maxSerialStages" in change || "maxJudgmentsPerStage" in change || "maxRepairs" in change
        ? { ...(change.maxSerialStages !== undefined ? { maxSerialStages: change.maxSerialStages } : {}),
          ...(change.maxJudgmentsPerStage !== undefined ? { maxJudgmentsPerStage: change.maxJudgmentsPerStage } : {}),
          ...(change.maxRepairs !== undefined ? { maxRepairs: change.maxRepairs } : {}) } : {}) },
      budgets: { ...current.budgets, ...(change.answerMs !== undefined ? { answerMs: change.answerMs } : {}),
        ...(change.jevMs !== undefined ? { jevMs: change.jevMs } : {}) } } : current);
  }

  const required = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "required") : [];
  const optional = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "optional") : [];
  const recorded = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "record") : [];

  return <section aria-label="回答の採点設定">
    <div className="admin-token">
      <label htmlFor="admin-token">管理用の鍵</label>
      <input id="admin-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
      <div className="admin-actions">
        <button type="button" disabled={busy || !token} onClick={() => void load()}>現在の設定を読み込む</button>
        {server && <button type="button" disabled={busy} onClick={() => void load()}>読み込み直す</button>}
      </div>
      <p className="input-note">鍵はブラウザからサーバーへ送るだけで、保存や記録はしません。試用版を見るための鍵とは別です。</p>
    </div>
    {error && <p role="alert" className="error-message">{error}</p>}
    {notice && <p className="input-note">{notice}</p>}
    {server && draft && <>
      <h2>現在の設定</h2>
      <p className="input-note">{server.current
        ? `第${server.current.version}版（${new Date(server.current.createdAt).toLocaleString("ja-JP")}に保存）`
        : "保存された設定はまだありません。表示しているのは初期値です。"}
        {server.previous ? ` / 戻し先: 第${server.previous.version}版` : " / 戻せる直前の設定はありません"}</p>
      <h2>評価項目の閾値と扱い</h2>
      <table className="admin-axes">
        <thead><tr><th>項目</th><th>閾値（0〜1）</th><th>扱い</th></tr></thead>
        <tbody>{jevQuestionIds.map(axis => <tr key={axis}>
          <td>{axisLabels[axis]}</td>
          <td><input type="number" min={0} max={1} step={0.05} value={draft.axes[axis].threshold}
            onChange={event => editAxis(axis, { threshold: Number(event.target.value) })} /></td>
          <td><select value={draft.axes[axis].treatment} onChange={event => editAxis(axis, { treatment: event.target.value as JevAxisTreatment })}>
            {jevTreatments.map(treatment => <option key={treatment} value={treatment}>{treatmentLabels[treatment]}</option>)}
          </select><small className="admin-note">{treatmentNotes[draft.axes[axis].treatment]}</small></td>
        </tr>)}</tbody>
      </table>
      <h2>不採用にする条件と実行の上限</h2>
      <div className="admin-fields">
        <label>任意項目の不合格がこの件数以上で不採用（0は任意だけでは不採用にしない）
          <input type="number" min={0} max={jevQuestionIds.length} step={1} value={draft.optionalFailureLimit}
            onChange={event => editNumber({ optionalFailureLimit: Number(event.target.value) })} /></label>
        <label>直列の段階数（1〜{jevCeilings.maxSerialStages}）
          <input type="number" min={1} max={jevCeilings.maxSerialStages} step={1} value={draft.limits.maxSerialStages}
            onChange={event => editNumber({ maxSerialStages: Number(event.target.value) })} /></label>
        <label>段階内の判定数（1〜{jevCeilings.maxJudgmentsPerStage}）
          <input type="number" min={1} max={jevCeilings.maxJudgmentsPerStage} step={1} value={draft.limits.maxJudgmentsPerStage}
            onChange={event => editNumber({ maxJudgmentsPerStage: Number(event.target.value) })} /></label>
        <label>修復回数（0〜{jevCeilings.maxRepairs}）
          <input type="number" min={0} max={jevCeilings.maxRepairs} step={1} value={draft.limits.maxRepairs}
            onChange={event => editNumber({ maxRepairs: Number(event.target.value) })} /></label>
        <label>回答全体の時間予算（ミリ秒）
          <input type="number" min={jevCeilings.answerMs.min} max={jevCeilings.answerMs.max} step={1000} value={draft.budgets.answerMs}
            onChange={event => editNumber({ answerMs: Number(event.target.value) })} /></label>
        <label>JEV1回の時間予算（ミリ秒）
          <input type="number" min={jevCeilings.jevMs.min} max={jevCeilings.jevMs.max} step={500} value={draft.budgets.jevMs}
            onChange={event => editNumber({ jevMs: Number(event.target.value) })} /></label>
      </div>
      <h2>この設定で決まること</h2>
      <p className="admin-summary">項目の不合格は「スコア &lt; 閾値」で、同点は合格です。スコアは未校正の判定値で、正答率ではありません。</p>
      <p className="admin-summary">必須: {required.map(axis => axisLabels[axis]).join("・") || "なし"}（1つでも不合格なら不採用）</p>
      <p className="admin-summary">任意: {optional.map(axis => axisLabels[axis]).join("・") || "なし"}（{draft.optionalFailureLimit === 0
        ? "任意だけでは不採用にしない" : `${draft.optionalFailureLimit}件以上で不採用`}）</p>
      <p className="admin-summary">記録のみ: {recorded.map(axis => axisLabels[axis]).join("・") || "なし"}（採否の件数に入れない）</p>
      <div className="admin-actions">
        <button type="button" className="send-button" disabled={busy} onClick={() => void send("save", "保存しました。次の質問から文字・音声の両方に反映されます。")}>保存する</button>
        <button type="button" disabled={busy || !server.previous} onClick={() => void send("revertPrevious", "直前の設定へ戻しました。次の質問から反映されます。")}>直前の設定へ戻す</button>
        <button type="button" disabled={busy} onClick={() => void send("resetDefaults", "初期値へ戻しました。保存済みの履歴は残っています。")}>初期値へ戻す</button>
      </div>
      <p className="input-note">通信の障害や不正な応答は、閾値を下げても合格にはなりません。公開範囲・認証・秘密情報の扱いは、この設定とは別に維持されます。</p>
    </>}
  </section>;
}
