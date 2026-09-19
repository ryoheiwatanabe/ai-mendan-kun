"use client";

import { useState } from "react";
import { jevQuestionIds, type JevAxis, type JevScores } from "../lib/ai/jev.ts";
import { jevScopeNoulIds, jevScopeOrder, type JevScopeNoulAxis } from "../lib/ai/jev-scope.ts";
import { evaluatedAxes, jevBackends, jevCeilings, jevLowConfidenceActions, jevTreatments, jevVerdict, minimumJudgments,
  type JevAxisTreatment, type JevBackend, type JevLowConfidenceAction, type JevSettings } from "../lib/answer/jev-settings.ts";
import type { JevScoreSample, JevStageMetric } from "../lib/answer/jev-settings-store.ts";

const axisLabels: Record<JevAxis, string> = {
  target_match: "対象一致", aspect_match: "項目一致", claims_supported: "根拠支持",
  no_invented_causality: "因果の非創作", no_scope_expansion: "範囲の保持", no_unnecessary_abstention: "不要な棄権の回避"
};
const scopeLabels: Record<JevScopeNoulAxis, string> = {
  target_match: "対象の一致", time_match: "時期の一致", direct_support: "直接の支持",
  background_support: "背景としての有用さ", causal_support: "因果の明記", conflict_risk: "矛盾の危険"
};
// 高いほど注意が必要な軸。それ以外は「この値以上で満たす」。
const scopeRisks: JevScopeNoulAxis[] = ["conflict_risk"];
const lowConfidenceLabels: Record<JevLowConfidenceAction, string> = {
  proceed: "そのまま使う", "second-stage": "もう1段階だけ聞き直す", partial: "控えめな範囲へ落とす", hold: "回答を保留する（不明と案内）"
};
const stageLabels: Record<string, string> = { scope: "生成前の選別", generation: "回答の生成", judge: "回答の点検", repair: "修復の生成",
  screening: "候補の絞り込み", "probe-official": "比較: 公式HTTP", "probe-workers-ai": "比較: Workers AI" };
const backendLabels: Record<JevBackend, string> = { official: "TypeSafe公式HTTP（既定）", "workers-ai": "Cloudflare Workers AI（typesafe/jev）" };
const treatmentLabels: Record<JevAxisTreatment, string> = { required: "必須", optional: "任意", record: "記録のみ" };
const treatmentNotes: Record<JevAxisTreatment, string> = {
  required: "1つでも不合格なら不採用", optional: "不合格の件数に数える", record: "採否に使わない"
};

type StoredSettings = { version: number; createdAt: string; settings: JevSettings | null; invalid: boolean };
type Payload = { current: StoredSettings | null; previous: StoredSettings | null; samples?: JevScoreSample[];
  metrics?: JevStageMetric[]; defaults: JevSettings; ceilings: typeof jevCeilings;
  note?: string; error?: { code?: string; message?: string } };

// 記録した採点へ編集中の設定を当てた結果。回答やJEVは再実行しない。
function sampleResult(sample: JevScoreSample, settings: JevSettings): string {
  if (sample.kind === "scope") {
    // 生成前の選別は型が混ざるため、記録したNoulの値と閾値だけを並べる。
    return jevScopeNoulIds.flatMap(axis => {
      const value = sample.scores[axis];
      if (typeof value !== "number") return [];
      const threshold = settings.scope.thresholds[axis];
      const meets = scopeRisks.includes(axis) ? value < threshold : value >= threshold;
      return [`${scopeLabels[axis]} ${value.toFixed(2)}${meets ? "○" : "×"}`];
    }).join(" / ");
  }
  const verdict = jevVerdict(sample.scores as JevScores, settings);
  const failed = verdict.failedAxes.map(axis => axisLabels[axis]).join("・");
  return verdict.accepted ? "採用（この設定では不合格なし）"
    : `不採用（${verdict.reason === "required" ? "必須" : "任意の件数"}: ${failed}）`;
}

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
  function editScopeThreshold(axis: JevScopeNoulAxis, threshold: number) {
    setDraft(current => current ? { ...current, scope: { ...current.scope, thresholds: { ...current.scope.thresholds, [axis]: threshold } } } : current);
  }
  function editScope(change: Partial<Pick<JevSettings["scope"], "enabled" | "maxQuestions" | "supportThreshold" | "confidenceThreshold" | "lowConfidenceAction">>) {
    setDraft(current => current ? { ...current, scope: { ...current.scope, ...change } } : current);
  }
  function editJudge(backend: JevBackend) {
    setDraft(current => current ? { ...current, judge: { ...current.judge, backend } } : current);
  }
  function editScreening(change: Partial<JevSettings["scope"]["screening"]>) {
    setDraft(current => current ? { ...current, scope: { ...current.scope, screening: { ...current.scope.screening, ...change } } } : current);
  }
  function editBeam(change: Partial<JevSettings["beam"]>) {
    setDraft(current => current ? { ...current, beam: { ...current.beam, ...change } } : current);
  }
  function editNumber(change: { optionalFailureLimit?: number; maxSerialStages?: number; maxJudgmentsPerStage?: number;
    maxRepairs?: number; answerMs?: number; jevMs?: number }) {
    setDraft(current => {
      if (!current) return current;
      const { optionalFailureLimit, maxSerialStages, maxJudgmentsPerStage, maxRepairs, answerMs, jevMs } = change;
      return { ...current,
        ...(optionalFailureLimit === undefined ? {} : { optionalFailureLimit }),
        limits: { ...current.limits, ...(maxSerialStages === undefined ? {} : { maxSerialStages }),
          ...(maxJudgmentsPerStage === undefined ? {} : { maxJudgmentsPerStage }), ...(maxRepairs === undefined ? {} : { maxRepairs }) },
        budgets: { ...current.budgets, ...(answerMs === undefined ? {} : { answerMs }), ...(jevMs === undefined ? {} : { jevMs }) } };
    });
  }

  const required = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "required") : [];
  const optional = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "optional") : [];
  const recorded = draft ? jevQuestionIds.filter(axis => draft.axes[axis].treatment === "record") : [];
  const judgedAxes = draft ? Math.max(1, Math.min(jevQuestionIds.length, draft.limits.maxJudgmentsPerStage)) : 0;
  const judged = draft ? evaluatedAxes(draft) : [];
  const minimumJudged = draft ? minimumJudgments(draft) : 1;
  const scopeJudgments = draft ? Math.max(1, Math.min(draft.scope.maxQuestions, draft.limits.maxJudgmentsPerStage)) : 0;
  const metrics = server?.metrics ?? [];
  const generations = metrics.find(metric => metric.stage === "generation")?.count ?? 0;
  const repairs = metrics.find(metric => metric.stage === "repair")?.count ?? 0;

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
      <h2>生成前の資料選別（JEV①）</h2>
      <p className="input-note">質問の前に候補資料を選別し、答えられる範囲と限定を生成へ渡します。1回のリクエストに独立した判定をまとめて送ります（実際に送る数: {scopeJudgments}件）。失敗・時間切れでは回答を止めず、回答の点検（JEV②）は必ず行います。</p>
      <table className="admin-axes">
        <thead><tr><th>判定の型</th><th>項目</th><th>設定</th></tr></thead>
        <tbody>
          <tr><td>Choice</td><td>答えられる範囲（answerable / partial / insufficient / ambiguous）</td><td className="admin-note">コード側で採点</td></tr>
          <tr><td>Choice</td><td>資料の役割（direct / background / irrelevant / conflict / mixed）</td><td className="admin-note">コード側で採点</td></tr>
          <tr><td>Choice</td><td>主な根拠（検索候補のIDから動的に選択肢を作る）</td><td className="admin-note">候補集合の外は採用しない</td></tr>
          <tr><td>Score</td><td>支持の強さ（0〜3の段階）
            <input type="number" min={0} max={1} step={0.05} value={draft.scope.supportThreshold}
              onChange={event => editScope({ supportThreshold: Number(event.target.value) })} /></td>
            <td className="admin-note">0〜1へ写して、この値以上なら「強い」と指示する</td></tr>
        </tbody>
      </table>
      <div className="admin-fields">
        <label>選別を行う
          <input type="checkbox" checked={draft.scope.enabled} onChange={event => editScope({ enabled: event.target.checked })} /></label>
        <label>前段で聞く判定の数（1〜{Math.min(jevCeilings.maxJudgmentsPerStage, jevScopeOrder.length)}）
          <input type="number" min={1} max={Math.min(jevCeilings.maxJudgmentsPerStage, jevScopeOrder.length)} step={1} value={draft.scope.maxQuestions}
            onChange={event => editScope({ maxQuestions: Number(event.target.value) })} /></label>
        <label>確信度の閾値（0〜1、これ未満を低確信とする）
          <input type="number" min={0} max={1} step={0.05} value={draft.scope.confidenceThreshold}
            onChange={event => editScope({ confidenceThreshold: Number(event.target.value) })} /></label>
        <label>低確信のときの行き先
          <select value={draft.scope.lowConfidenceAction} onChange={event => editScope({ lowConfidenceAction: event.target.value as JevLowConfidenceAction })}>
            {jevLowConfidenceActions.map(action => <option key={action} value={action}>{lowConfidenceLabels[action]}</option>)}
          </select><small className="admin-note">確信度は確からしさの目安で、正答率ではありません</small></label>
      </div>
      <table className="admin-axes">
        <thead><tr><th>選別の項目（Noul）</th><th>閾値（0〜1）</th><th>見方</th></tr></thead>
        <tbody>{jevScopeNoulIds.map(axis => <tr key={axis}>
          <td>{scopeLabels[axis]}</td>
          <td><input type="number" min={0} max={1} step={0.05} value={draft.scope.thresholds[axis]}
            onChange={event => editScopeThreshold(axis, Number(event.target.value))} /></td>
          <td className="admin-note">{scopeRisks.includes(axis) ? "この値以上で注意として扱う" : "この値以上で満たす"}</td>
        </tr>)}</tbody>
      </table>
      <h2>回答の点検と不採用の条件（JEV②）</h2>
      <h2>判定の呼び出し先と、候補の絞り込み</h2>
      <div className="admin-fields">
        <label>JEVの呼び出し先（管理者用）
          <select value={draft.judge.backend} onChange={event => editJudge(event.target.value as JevBackend)}>
            {jevBackends.map(backend => <option key={backend} value={backend}>{backendLabels[backend]}</option>)}
          </select><small className="admin-note">Workers AIへ切り替えると、資料の送信先が変わります</small></label>
        <label>候補が多いときに絞り込む
          <input type="checkbox" checked={draft.scope.screening.enabled} onChange={event => editScreening({ enabled: event.target.checked })} /></label>
        <label>絞り込みを始める候補数（2〜100）
          <input type="number" min={2} max={100} step={1} value={draft.scope.screening.candidateThreshold}
            onChange={event => editScreening({ candidateThreshold: Number(event.target.value) })} /></label>
        <label>絞り込んだ後に残す数（1〜{jevCeilings.maxJudgmentsPerStage}）
          <input type="number" min={1} max={jevCeilings.maxJudgmentsPerStage} step={1} value={draft.scope.screening.keep}
            onChange={event => editScreening({ keep: Number(event.target.value) })} /></label>
      </div>
      <p className="input-note">絞り込みは1段階を使います。段階数3では絞り込み＋選別＋点検で使い切るため、その質問では修復と2段目を行いません。段階数2では絞り込み＋点検だけになり、選別は行いません。範囲外へ落とした候補は件数と理由（beyond_screen_limit）を実行記録に残します。既定はオフです。呼び出し先の比較は <code>POST /api/admin/jev-probe</code>（架空の資料のみ・1〜5回）で行えます。</p>
      <h2>根拠を複数ルートで探す（ビーム探索）</h2>
      <div className="admin-fields">
        <label>根拠を複数ルートで探す
          <input type="checkbox" checked={draft.beam.enabled} onChange={event => editBeam({ enabled: event.target.checked })} /></label>
        <label>同時に残す候補ルート数（{jevCeilings.beam.width.min}〜{jevCeilings.beam.width.max}）
          <input type="number" min={jevCeilings.beam.width.min} max={jevCeilings.beam.width.max} step={1} value={draft.beam.width}
            onChange={event => editBeam({ width: Number(event.target.value) })} /></label>
        <label>1巡で評価する候補ルート数（{jevCeilings.beam.candidatesPerRound.min}〜{jevCeilings.beam.candidatesPerRound.max}）
          <input type="number" min={jevCeilings.beam.candidatesPerRound.min} max={jevCeilings.beam.candidatesPerRound.max} step={1}
            value={draft.beam.candidatesPerRound} onChange={event => editBeam({ candidatesPerRound: Number(event.target.value) })} /></label>
        <label>探索の最大回数（{jevCeilings.beam.maxRounds.min}〜{jevCeilings.beam.maxRounds.max}）
          <input type="number" min={jevCeilings.beam.maxRounds.min} max={jevCeilings.beam.maxRounds.max} step={1} value={draft.beam.maxRounds}
            onChange={event => editBeam({ maxRounds: Number(event.target.value) })} /></label>
        <label>追加探索に使う時間（ミリ秒・{jevCeilings.beam.explorationMs.min}〜{jevCeilings.beam.explorationMs.max}）
          <input type="number" min={jevCeilings.beam.explorationMs.min} max={jevCeilings.beam.explorationMs.max} step={500}
            value={draft.beam.explorationMs} onChange={event => editBeam({ explorationMs: Number(event.target.value) })} /></label>
      </div>
      <p className="input-note">オフなら現在の経路（絞り込み→選別→生成→点検）のままです。オンにすると、既存の検索結果から複数の根拠ルートを作り、JEVで支持と不足を評価してから、最も支えられるルートで回答を1回だけ生成します。1ルートにつき2判定（直接支持・不足）を使うため、1巡の判定数は候補ルート数の2倍です。探索は1巡につき段階を1つ使い、最終点検と修復の分を残します。4〜5段で試す場合は「直列の段階数」も合わせて増やしてください。</p>
      <p className="input-note">今回の点検で評価する軸（{judgedAxes}軸）: {judged.map(axis => axisLabels[axis]).join("・")}。必須の軸は必ず含め、残り枠は任意→記録のみの順に埋めます。評価しない軸は採否に使いません。</p>
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
      <h2>実行の上限</h2>
      <div className="admin-fields">
        <label>任意項目の不合格がこの件数以上で不採用（0は任意だけでは不採用にしない）
          <input type="number" min={0} max={jevQuestionIds.length} step={1} value={draft.optionalFailureLimit}
            onChange={event => editNumber({ optionalFailureLimit: Number(event.target.value) })} /></label>
        <label>直列の段階数（1〜{jevCeilings.maxSerialStages}）
          <input type="number" min={1} max={jevCeilings.maxSerialStages} step={1} value={draft.limits.maxSerialStages}
            onChange={event => editNumber({ maxSerialStages: Number(event.target.value) })} />
          <small className="admin-note">1=点検のみ / 2=選別＋点検 / 3=選別＋点検＋修復後の点検</small></label>
        <label>段階内の判定数（{minimumJudged}〜{jevCeilings.maxJudgmentsPerStage}）
          <input type="number" min={minimumJudged} max={jevCeilings.maxJudgmentsPerStage} step={1} value={draft.limits.maxJudgmentsPerStage}
            onChange={event => editNumber({ maxJudgmentsPerStage: Number(event.target.value) })} />
          <small className="admin-note">HTTPの回数ではなく、1回のリクエストへまとめる独立判定の数。必須の軸数（{minimumJudged}）より小さくできません</small></label>
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
      <p className="admin-summary">回答の項目の不合格は「スコア &lt; 閾値」で、同点は合格です。スコアも確信度も未校正の判定値で、正答率ではありません。</p>
      <p className="admin-summary">必須: {required.map(axis => axisLabels[axis]).join("・") || "なし"}（1つでも不合格なら不採用）</p>
      <p className="admin-summary">任意: {optional.map(axis => axisLabels[axis]).join("・") || "なし"}（{draft.optionalFailureLimit === 0
        ? "任意だけでは不採用にしない" : `${draft.optionalFailureLimit}件以上で不採用`}）</p>
      <p className="admin-summary">記録のみ: {recorded.map(axis => axisLabels[axis]).join("・") || "なし"}（採否の件数に入れない）</p>
      <p className="admin-summary">生成前の選別: {draft.scope.enabled ? `行う（判定${scopeJudgments}件）` : "行わない"}。低確信（{draft.scope.confidenceThreshold}未満）は「{lowConfidenceLabels[draft.scope.lowConfidenceAction]}」。</p>
      <div className="admin-actions">
        <button type="button" className="send-button" disabled={busy} onClick={() => void send("save", "保存しました。次の質問から文字・音声の両方に反映されます。")}>保存する</button>
        <button type="button" disabled={busy || !server.previous} onClick={() => void send("revertPrevious", "直前の設定へ戻しました。次の質問から反映されます。")}>直前の設定へ戻す</button>
        <button type="button" disabled={busy} onClick={() => void send("resetDefaults", "初期値へ戻しました。保存済みの履歴は残っています。")}>初期値へ戻す</button>
      </div>
      <h2>段階ごとの所要時間</h2>
      <p className="input-note">直近200件までの記録から出した実測です（日本からの利用を含む）。修復率は回答の生成に対する修復の割合です。</p>
      {!metrics.length ? <p className="input-note">まだ記録がありません。質問すると、ここに段階ごとの時間が並びます。</p>
        : <>
          <table className="admin-axes">
            <thead><tr><th>段階</th><th>件数</th><th>p50</th><th>p95</th></tr></thead>
            <tbody>{metrics.map(metric => <tr key={metric.stage}>
              <td>{stageLabels[metric.stage] ?? metric.stage}</td><td>{metric.count}</td><td>{metric.p50}ms</td><td>{metric.p95}ms</td>
            </tr>)}</tbody>
          </table>
          <p className="admin-summary">修復率: {generations ? `${(repairs / generations * 100).toFixed(1)}%（修復${repairs} / 生成${generations}）` : "記録なし"}</p>
        </>}
      <h2>記録した採点に、この設定を当てた結果</h2>
      <p className="input-note">編集中の値を、直近に記録した採点へ当てた例です。回答やJEVは再実行しません。本文は記録していません。</p>
      {!server.samples?.length ? <p className="input-note">まだ採点の控えがありません。質問すると、直近10件までここに並びます。</p>
        : <ul className="admin-samples">{server.samples.map((sample, index) => <li key={`${sample.createdAt}:${sample.kind}:${index}`}>
          <span className="admin-sample-time">{new Date(sample.createdAt).toLocaleString("ja-JP")}</span>
          <span className="admin-sample-kind">{sample.kind === "scope" ? "生成前の選別" : "回答の点検"}</span>
          <span className="admin-sample-result">{sampleResult(sample, draft)}</span>
        </li>)}</ul>}
      <p className="input-note">通信の障害や不正な応答は、閾値を下げても合格にはなりません。公開範囲・認証・秘密情報の扱いは、この設定とは別に維持されます。</p>
    </>}
  </section>;
}
