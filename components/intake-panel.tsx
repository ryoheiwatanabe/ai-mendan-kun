"use client";

import { useEffect, useState } from "react";
import { ADMIN_HEADER } from "../lib/security/admin.ts";
import { clearStoredAdminKey, readStoredAdminKey, storeAdminKey } from "../lib/admin-key.ts";

type IntakeOmitted = { item: string; reason: string };
type DraftView = { id: string; sourceId?: string; status: "draft" | "held" | "approved" | "rejected"; title: string; publicText: string;
  aliases: string[]; topic: string; kept: string[]; omitted: IntakeOmitted[]; questions: string[]; model: string;
  promptVersion: string; approvedRevisionId: string | null; createdAt: string; updatedAt: string; version: number; approvalHash?: string;
  // 自動リライト（#6）で採用した方針の版。autoAdoptedなら、本人の一語一句レビューではない。
  autoPolicyVersion?: string; autoAdopted?: boolean;
  // 保存済み下書きに紐づく公開対象。最終確認はこの値だけを使う（作成フォームの状態は使わない）。
  target?: { kind: "new" | "replace" | "unresolved"; documentId?: string; revisionId?: string; title?: string; facts?: number; chunks?: number } };
type SourceView = { id: string; title: string; contentHash: string; replacesRevisionId: string | null; createdAt: string; rawText?: string };
type PublicDocument = { documentId: string; revisionId: string; title: string; facts: number; chunks: number };
type Published = { title: string; publicText: string; aliases: string[]; topic: string };
type Payload = { sources?: SourceView[]; drafts?: DraftView[]; publicDocuments?: PublicDocument[];
  destination?: { label: string; rawStorage: string }; providerReady?: boolean;
  provider?: { label: string; model: string; promptVersion: string }; error?: { code?: string; message?: string };
  draft?: DraftView; published?: Published; revisionId?: string; replaced?: boolean; lostFacts?: number;
  exclusionRevision?: string; autoPolicyVersion?: string; autoAdopted?: boolean; held?: boolean; reason?: string;
  reused?: boolean; revoked?: boolean; vectorCleanupPending?: boolean;
  pending?: boolean;
  meaningCheck?: { available: boolean; label: string };
  usage?: { input: number; output: number } };

// 公開用資料を整える（#5）。原文→候補→本人の編集・承認→検索登録までを1画面で行う。
// 承認できるのは「保存済みの内容」だけ。未保存の編集がある間は承認できない。
export function IntakePanel() {
  const [token, setToken] = useState("");
  const [server, setServer] = useState<Payload | null>(null);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [replaces, setReplaces] = useState("");
  const [consent, setConsent] = useState(false);
  const [publicTarget, setPublicTarget] = useState(false);
  // 自動取り込みの再試行で重複しないよう、この試行のIDを1つ送る。
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [factLossOk, setFactLossOk] = useState(false);
  const [published, setPublished] = useState<Published | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);

  // 前回この端末に記憶した鍵があれば、開いた時点で読み込む。
  useEffect(() => {
    const stored = readStoredAdminKey();
    if (!stored) return;
    setToken(stored); setRemember(true);
    void load(stored);
  }, []);

  // 作成フォームの選択（これから作る候補の置換先）。
  const formTarget = (server?.publicDocuments ?? []).find(item => item.revisionId === replaces) ?? null;
  // 表示中の下書き（保存済み）の公開対象。承認の判断はこちらだけを使う。
  const savedTarget = draft?.target ?? null;
  const needsFactOk = savedTarget?.kind === "replace" && (savedTarget.facts ?? 0) > 0;

  async function call(method: "GET" | "POST", body?: unknown, key = token) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/intake", { method, headers: { [ADMIN_HEADER]: key, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error?.message || "処理を続けられませんでした。");
      // 通った鍵だけを、記憶を選んでいるときに残す。
      if (remember) storeAdminKey(key);
      return payload;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "処理を続けられませんでした。"); return null; }
    finally { setBusy(false); }
  }
  async function load(key = token) {
    const payload = await call("GET", undefined, key);
    if (!payload) return;
    setServer(payload); setNotice("管理データを読み込みました。");
  }
  function toggleRemember(next: boolean) {
    setRemember(next);
    // 外したときは、この端末に残した鍵を消す。サーバー側の鍵は変わらない。
    if (!next) clearStoredAdminKey();
  }

  function edit(change: Partial<DraftView>) {
    if (!draft) return;
    // 編集したら承認対象から外す。保存して戻ってきた内容だけを承認できる。
    setDraft({ ...draft, ...change });
    setDirty(true); setConfirmed(false); setPublished(null);
  }
  async function prepare() {
    const payload = await call("POST", { action: "prepare", title, rawText, replacesRevisionId: replaces || undefined, acknowledgeStorage: consent });
    if (!payload?.draft) return;
    setDraft(payload.draft); setSource(null); setDirty(false); setConfirmed(false); setFactLossOk(false); setPublished(null);
    const listed = await call("GET");
    if (listed) { setServer(listed); setSource((listed.sources ?? []).find(item => item.id === payload.draft!.sourceId) ?? null); }
    // 読み直しの後に知らせる（読み直しは通知を消すため）。
    setNotice("公開用候補を作りました。原文と候補を確認して、必要なら直して保存してください。");
  }
  async function save(action: "save" | "hold" | "reject") {
    if (!draft) return;
    const payload = await call("POST", { action, draftId: draft.id, title: draft.title, publicText: draft.publicText,
      aliases: draft.aliases, topic: draft.topic });
    if (!payload?.draft) return;
    setDraft(payload.draft); setDirty(false); setConfirmed(false); setPublished(null);
    setNotice(action === "hold" ? "非公開のまま保留しました。" : action === "reject" ? "却下しました。公開はしていません。" : "下書きを保存しました。内容を確認して、承認してください。");
  }
  // #6: 公開対象として明示した原文を、意味を保つ面談向けリライトで自動適用する。
  // 言い換えごとの承認は挟まず、包括許可を超える箇所だけを保留して本人の確認へ回す。
  async function autoRewrite() {
    const payload = await call("POST", { action: "auto", title, rawText, replacesRevisionId: replaces || undefined,
      acknowledgeStorage: consent, publicTarget, requestId });
    if (!payload?.draft) return;
    // 次回は別の試行として扱う（同じIDの再送は、保存済みの下書きを使い回す）。
    setRequestId(crypto.randomUUID());
    setDraft(payload.draft); setDirty(false); setConfirmed(false); setFactLossOk(false);
    setPublished(payload.autoAdopted ? payload.published ?? null : null);
    const listed = await call("GET");
    if (listed) { setServer(listed); setSource((listed.sources ?? []).find(item => item.id === payload.draft!.sourceId) ?? null); }
    // 読み直しの後に知らせる（読み直しは通知を消すため）。
    setNotice(payload.autoAdopted
      ? (payload.vectorCleanupPending
        ? "意味を保つ面談向けの言い換えを自動適用し、検索へ登録しました。旧版の索引の後片付けは保留中です（公開状態は変わりません）。"
        : "意味を保つ面談向けの言い換えを自動適用し、検索へ登録しました。差分は後から確認・修正・取り消しできます。")
      : payload.pending
        ? "直前の試行がまだ終わっていません。少し待ってから、もう一度お試しください。"
        : payload.reused
          ? "同じ操作はすでに処理されています。下書きの状態を確認してください。"
          : "包括許可を超える箇所があるため、自動では採用せず非公開のまま保留しました。内容を確認してから承認してください。");
  }
  // 公開版の取り消し。既存の撤回処理へつなぎ、置換前の旧版は自動で復活させない。
  async function cancel() {
    if (!draft) return;
    const payload = await call("POST", { action: "cancel", draftId: draft.id });
    if (!payload?.draft) return;
    setDraft(payload.draft); setDirty(false); setConfirmed(false); setFactLossOk(false); setPublished(null);
    setNotice(payload.vectorCleanupPending
      ? "公開版を取り消しました。索引の後片付けは保留中です（公開へは戻りません）。"
      : "公開版を取り消しました。");
    await load();
  }
  async function approve() {
    if (!draft) return;
    const payload = await call("POST", { action: "approve", draftId: draft.id, approvalHash: draft.approvalHash,
      version: draft.version, ...(draft.target ? { expectedTarget: { kind: draft.target.kind,
        ...(draft.target.revisionId ? { revisionId: draft.target.revisionId } : {}) } } : {}),
      ...(factLossOk ? { acknowledgeFactLoss: true } : {}) });
    if (!payload?.draft) return;
    setDraft(payload.draft); setPublished(payload.published ?? null); setConfirmed(false); setDirty(false); setFactLossOk(false);
    setNotice(payload.vectorCleanupPending
      ? "公開版を登録し、置換対象の旧版を撤回しました。索引の後片付けは保留中です（公開状態は変わりません）。"
      : payload.replaced ? "公開版を登録し、置換対象の旧版を撤回しました。" : "公開版を検索へ登録しました。本体で質問できます。");
    await load();
  }

  return <section className="intake-panel">
    <h2>公開用資料を整える</h2>
    <p className="input-note">生の内省メモを、面談相手に見せてよい公開用の知識カードへ整えます。原文は管理専用の場所にだけ保存し、公開検索へは公開用の本文と検索語だけを登録します。</p>
    <form className="admin-token" onSubmit={event => { event.preventDefault(); if (!busy && token) void load(); }}>
      <label htmlFor="intake-token">管理用の鍵</label>
      {/* ブラウザーの自動入力へ渡すための名前。値そのものは判定に使わない。 */}
      <input type="text" name="username" value="mendan-admin" readOnly hidden autoComplete="username" />
      <input id="intake-token" name="admin-key" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} />
      <div className="admin-actions"><button type="submit" disabled={busy || !token}>読み込む</button></div>
      <label className="admin-remember">
        <input type="checkbox" checked={remember} onChange={event => toggleRemember(event.target.checked)} />
        <span>この端末に記憶する（次回から自動で入力）</span>
      </label>
      <p className="input-note">鍵はブラウザーからサーバーへ送るだけで、サーバーには保存しません。上のチェックを入れると、この端末のブラウザーだけに残り、次に開いたときに自動で入力します。共用の端末では外してください。採点設定と同じ鍵です。</p>
    </form>
    {error && <p role="alert" className="error-message">{error}</p>}
    {notice && <p className="admin-summary">{notice}</p>}
    {server?.destination && <p className="admin-note">登録先: {server.destination.label}</p>}
    {server?.destination && <p className="admin-note">{server.destination.rawStorage}</p>}

    <h2>1. 原文を選ぶ</h2>
    <div className="admin-fields">
      <label>文書名（公開カードの見出し）
        <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
      <label>置換する既存の公開版（任意）
        <select value={replaces} onChange={event => setReplaces(event.target.value)}>
          <option value="">置換しない（新しいカードとして追加）</option>
          {(server?.publicDocuments ?? []).map(item => <option key={item.revisionId} value={item.revisionId}>
            {item.title}（{item.revisionId.slice(0, 12)}…・Fact {item.facts}件・{item.chunks}段落）</option>)}
        </select><small className="admin-note">選ぶと、承認後に旧版を撤回して同じ文書の新しい版にします。承認までは旧版を消しません</small></label>
    </div>
    <label className="admin-note" htmlFor="intake-source">原文（この本文が変換の送信対象です）</label>
    <textarea id="intake-source" className="intake-source" value={rawText} maxLength={20000} rows={8}
      placeholder="本人の内省メモや面談の記録を貼り付けます。この原文は公開されません。"
      onChange={event => setRawText(event.target.value)} />
    <label className="admin-note"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
      {" "}原文をCloudflareの管理専用テーブルへ保存し、公開用候補の作成のため{server?.provider?.label || "設定済みの提供元"}へ送り、意味保持の確認のため{server?.meaningCheck?.label || "設定済みの判定先"}へ送ることに同意します</label>
    <label className="admin-note"><input type="checkbox" checked={publicTarget} onChange={event => setPublicTarget(event.target.checked)} />
      {" "}この原文を公開対象として取り込み、意味を保つ面談向けの言い換えを自動適用する（言い換えごとの承認なし）</label>
    <div className="admin-actions">
      <button type="button" onClick={prepare} disabled={busy || !token || !consent || server?.providerReady !== true
        || title.trim().length === 0 || rawText.trim().length < 20}>公開用候補を作る</button>
      <button type="button" onClick={autoRewrite} disabled={busy || !token || !consent || !publicTarget || server?.providerReady !== true
        || title.trim().length === 0 || rawText.trim().length < 20}>自動リライトで取り込む</button>
    </div>
    {server?.exclusionRevision && <p className="admin-note">非表示の設定版: {server.exclusionRevision}（規則の実値は表示しません）。該当する内容は公開せず保留します。</p>}
    {server !== null && server.providerReady !== true && <p className="admin-note">変換の送信先（提供元）を確認できないため、候補づくりはできません。設定を確認してください。</p>}
    {formTarget && formTarget.facts > 0 && <p className="admin-note">この設定で候補を作ると、置換対象のFact {formTarget.facts}件は新しいカードへ引き継がれません。必要な内容は公開用の本文に含めてください。</p>}

    {draft && <div className="intake-review">
      <h2>2. 候補を確認して直す</h2>
      <p className="admin-note">状態: {draft.status === "draft" ? "下書き" : draft.status === "held" ? "保留中" : draft.status === "approved" ? "登録済み" : "却下"}
        {" / "}保存版 v{draft.version} / モデル {draft.model || "未設定"} / 指示の版 {draft.promptVersion}</p>
      {draft.autoAdopted && <p className="admin-note">この登録は、編集方針 {draft.autoPolicyVersion || server?.autoPolicyVersion} に基づく自動適用です（本人が一語一句レビューした記録ではありません）。差分は後から確認・修正・取り消しできます。</p>}
      {source?.rawText && <details className="intake-original"><summary>原文を表示（公開しません）</summary><pre>{source.rawText}</pre></details>}
      <div className="admin-fields">
        <label>公開用の本文
          <textarea className="intake-public" rows={8} value={draft.publicText} maxLength={8000}
            onChange={event => edit({ publicText: event.target.value })} /></label>
        <label>検索語（カンマ区切り・1〜12件）
          <input value={draft.aliases.join(", ")} onChange={event => edit({ aliases: event.target.value.split(",").map(item => item.trim()).filter(Boolean) })} /></label>
        <label>分類（例: work_values）
          <input value={draft.topic} maxLength={40} onChange={event => edit({ topic: event.target.value })} /></label>
      </div>
      <ul className="admin-samples">
        <li><span className="admin-sample-kind">残した要点</span><span className="admin-sample-result">{draft.kept.join(" / ") || "（なし）"}</span></li>
        <li><span className="admin-sample-kind">省略した内容</span><span className="admin-sample-result">{draft.omitted.map(item => item.item + "（" + item.reason + "）").join(" / ") || "（なし）"}</span></li>
        <li><span className="admin-sample-kind">要確認</span><span className="admin-sample-result">{draft.questions.join(" / ") || "（なし）"}</span></li>
      </ul>
      <div className="admin-actions">
        <button type="button" onClick={() => save("save")} disabled={busy || !dirty}>下書き保存</button>
        <button type="button" onClick={() => save("hold")} disabled={busy || !dirty}>{draft.approvedRevisionId ? "編集を保留（公開版は維持）" : "非公開のまま保留"}</button>
        <button type="button" onClick={() => save("reject")} disabled={busy || draft.status === "approved"}>却下する</button>
      </div>
      {dirty && <p className="input-note">編集中の内容はまだ保存されていません。「下書き保存」を押すと、この内容が承認の対象になります。</p>}

      {!dirty && draft.status !== "approved" && savedTarget?.kind !== "unresolved" && <div className="intake-confirm">
        <h2>3. 公開内容の最終確認</h2>
        <p className="admin-note">登録先: {server?.destination?.label}</p>
        <ul className="admin-samples">
          <li><span className="admin-sample-kind">見出し</span><span className="admin-sample-result">{draft.title}</span></li>
          <li><span className="admin-sample-kind">公開本文</span><span className="admin-sample-result">{draft.publicText}</span></li>
          <li><span className="admin-sample-kind">検索語</span><span className="admin-sample-result">{draft.aliases.join(" / ")}</span></li>
          <li><span className="admin-sample-kind">種別</span><span className="admin-sample-result">{savedTarget?.kind === "replace"
            ? "置換（対象: " + (savedTarget.title ?? savedTarget.revisionId) + "・Fact " + (savedTarget.facts ?? 0) + "件は引き継がれない）"
            : savedTarget?.kind === "new" ? "新規カードとして追加" : "対象を確認できません"}</span></li>
        </ul>
        {needsFactOk && <label className="admin-note"><input type="checkbox" checked={factLossOk}
          onChange={event => setFactLossOk(event.target.checked)} /> {" "}Fact {savedTarget?.facts}件が引き継がれないことを了解しました</label>}
        <label className="admin-note"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          {" "}上の見出し・公開本文・検索語で登録します（公開中のAI面談くんの回答にも反映されます）</label>
        <div className="admin-actions">
          <button type="button" onClick={approve} disabled={busy || !confirmed || savedTarget?.kind !== "new" && savedTarget?.kind !== "replace"
            || (needsFactOk && !factLossOk)}>承認して検索登録</button>
        </div>
      </div>}
      {!dirty && draft.status !== "approved" && savedTarget?.kind === "unresolved" &&
        <p role="alert" className="error-message">置換先の版を確認できません。読み直して、対象を選び直してください。</p>}
      {published && <p className="admin-summary">登録した内容: {published.title} / {published.aliases.join("・")}（本文 {published.publicText.length}字）</p>}
      {(draft.approvedRevisionId || draft.status === "approved") && <p className="input-note">
        {draft.status === "approved" ? "この下書きは登録済みで、公開中です。"
          : "公開中の版があります（この下書きの状態: " + (draft.status === "held" ? "保留" : "下書き") + "）。"}
        編集して「下書き保存」すると、同じ文書の新しい版として再登録できます（公開中の版は直接変わりません）。公開をやめる場合は「公開版を取り消す」を押してください。</p>}
      {(draft.approvedRevisionId || draft.status === "approved") && <div className="admin-actions">
        <button type="button" onClick={cancel} disabled={busy}>公開版を取り消す</button>
      </div>}
    </div>}

    <h2>これまでの取り込み</h2>
    <ul className="admin-samples">
      {(server?.drafts ?? []).map(item => <li key={item.id}>
        <span className="admin-sample-time">{item.updatedAt.slice(0, 16).replace("T", " ")}</span>
        <span className="admin-sample-kind">{item.status === "draft" ? "下書き" : item.status === "held" ? "保留" : item.status === "approved" ? "登録済み" : "却下"}</span>
        <span className="admin-sample-result">{item.title}</span>
        <button type="button" className="text-link" onClick={async () => {
          const payload = await call("GET");
          if (!payload) return;
          setServer(payload);
          const found = (payload.drafts ?? []).find(entry => entry.id === item.id) ?? null;
          setDraft(found); setDirty(false); setConfirmed(false); setPublished(null); setFactLossOk(false);
          setSource((payload.sources ?? []).find(entry => entry.id === found?.sourceId) ?? null);
        }}>開く</button>
      </li>)}
      {!(server?.drafts ?? []).length && <li><span className="admin-sample-result">まだありません。</span></li>}
    </ul>
  </section>;
}
