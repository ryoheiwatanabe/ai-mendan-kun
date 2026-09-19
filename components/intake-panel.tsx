"use client";

import { useState } from "react";
import { ADMIN_HEADER } from "../lib/security/admin.ts";

type IntakeOmitted = { item: string; reason: string };
type DraftView = { id: string; sourceId?: string; status: "draft" | "held" | "approved" | "rejected"; title: string; publicText: string;
  aliases: string[]; topic: string; kept: string[]; omitted: IntakeOmitted[]; questions: string[]; model: string;
  promptVersion: string; approvedRevisionId: string | null; createdAt: string; updatedAt: string; version: number; approvalHash?: string };
type SourceView = { id: string; title: string; contentHash: string; replacesRevisionId: string | null; createdAt: string; rawText?: string };
type PublicDocument = { documentId: string; revisionId: string; title: string; facts: number; chunks: number };
type Published = { title: string; publicText: string; aliases: string[]; topic: string };
type Payload = { sources?: SourceView[]; drafts?: DraftView[]; publicDocuments?: PublicDocument[];
  destination?: { label: string; rawStorage: string }; providerReady?: boolean;
  provider?: { label: string; model: string; promptVersion: string }; error?: { code?: string; message?: string };
  draft?: DraftView; published?: Published; revisionId?: string; replaced?: boolean; lostFacts?: number;
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
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [factLossOk, setFactLossOk] = useState(false);
  const [published, setPublished] = useState<Published | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const target = (server?.publicDocuments ?? []).find(item => item.revisionId === replaces) ?? null;
  const needsFactOk = target !== null && target.facts > 0;

  async function call(method: "GET" | "POST", body?: unknown) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/intake", { method, headers: { [ADMIN_HEADER]: token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error?.message || "処理を続けられませんでした。");
      return payload;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "処理を続けられませんでした。"); return null; }
    finally { setBusy(false); }
  }
  async function load() {
    const payload = await call("GET");
    if (!payload) return;
    setServer(payload); setNotice("管理データを読み込みました。");
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
    setNotice("公開用候補を作りました。原文と候補を確認して、必要なら直して保存してください。");
    const listed = await call("GET");
    if (listed) { setServer(listed); setSource((listed.sources ?? []).find(item => item.id === payload.draft!.sourceId) ?? null); }
  }
  async function save(action: "save" | "hold" | "reject") {
    if (!draft) return;
    const payload = await call("POST", { action, draftId: draft.id, title: draft.title, publicText: draft.publicText,
      aliases: draft.aliases, topic: draft.topic });
    if (!payload?.draft) return;
    setDraft(payload.draft); setDirty(false); setConfirmed(false); setPublished(null);
    setNotice(action === "hold" ? "非公開のまま保留しました。" : action === "reject" ? "却下しました。公開はしていません。" : "下書きを保存しました。内容を確認して、承認してください。");
  }
  async function approve() {
    if (!draft) return;
    const payload = await call("POST", { action: "approve", draftId: draft.id, approvalHash: draft.approvalHash,
      version: draft.version, ...(factLossOk ? { acknowledgeFactLoss: true } : {}) });
    if (!payload?.draft) return;
    setDraft(payload.draft); setPublished(payload.published ?? null); setConfirmed(false); setDirty(false); setFactLossOk(false);
    setNotice(payload.replaced ? "公開版を登録し、置換対象の旧版を撤回しました。" : "公開版を検索へ登録しました。本体で質問できます。");
    await load();
  }

  return <section className="intake-panel">
    <h2>公開用資料を整える</h2>
    <p className="input-note">生の内省メモを、面談相手に見せてよい公開用の知識カードへ整えます。原文は管理専用の場所にだけ保存し、公開検索へは公開用の本文と検索語だけを登録します。</p>
    <div className="admin-token">
      <label htmlFor="intake-token">管理用の鍵</label>
      <input id="intake-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
      <div className="admin-actions"><button type="button" onClick={load} disabled={busy || !token}>読み込む</button></div>
    </div>
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
      {" "}原文をCloudflareの管理専用テーブルへ保存し、公開用候補の作成のため{server?.provider?.label || "設定済みの提供元"}へ送ることに同意します</label>
    <div className="admin-actions">
      <button type="button" onClick={prepare} disabled={busy || !token || !consent || server?.providerReady !== true
        || title.trim().length === 0 || rawText.trim().length < 20}>公開用候補を作る</button>
    </div>
    {server !== null && server.providerReady !== true && <p className="admin-note">変換の送信先（提供元）を確認できないため、候補づくりはできません。設定を確認してください。</p>}
    {target && target.facts > 0 && <p className="admin-note">この置換では、置換対象のFact {target.facts}件は新しいカードへ引き継がれません。必要な内容は公開用の本文に含めてください。</p>}

    {draft && <div className="intake-review">
      <h2>2. 候補を確認して直す</h2>
      <p className="admin-note">状態: {draft.status === "draft" ? "下書き" : draft.status === "held" ? "保留中" : draft.status === "approved" ? "登録済み" : "却下"}
        {" / "}保存版 v{draft.version} / モデル {draft.model || "未設定"} / 指示の版 {draft.promptVersion}</p>
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
        <button type="button" onClick={() => save("hold")} disabled={busy || !dirty}>非公開のまま保留</button>
        <button type="button" onClick={() => save("reject")} disabled={busy || draft.status === "approved"}>却下する</button>
      </div>
      {dirty && <p className="input-note">編集中の内容はまだ保存されていません。「下書き保存」を押すと、この内容が承認の対象になります。</p>}

      {!dirty && draft.status !== "approved" && <div className="intake-confirm">
        <h2>3. 公開内容の最終確認</h2>
        <p className="admin-note">登録先: {server?.destination?.label}</p>
        <ul className="admin-samples">
          <li><span className="admin-sample-kind">見出し</span><span className="admin-sample-result">{draft.title}</span></li>
          <li><span className="admin-sample-kind">公開本文</span><span className="admin-sample-result">{draft.publicText}</span></li>
          <li><span className="admin-sample-kind">検索語</span><span className="admin-sample-result">{draft.aliases.join(" / ")}</span></li>
          <li><span className="admin-sample-kind">種別</span><span className="admin-sample-result">{replaces
            ? "置換（対象: " + (target?.title ?? replaces) + "・Fact " + (target?.facts ?? 0) + "件は引き継がれない）" : "新規カードとして追加"}</span></li>
        </ul>
        {needsFactOk && <label className="admin-note"><input type="checkbox" checked={factLossOk}
          onChange={event => setFactLossOk(event.target.checked)} /> {" "}Fact {target?.facts}件が引き継がれないことを了解しました</label>}
        <label className="admin-note"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          {" "}上の見出し・公開本文・検索語で登録します（公開中のAI面談くんの回答にも反映されます）</label>
        <div className="admin-actions">
          <button type="button" onClick={approve} disabled={busy || !confirmed || (needsFactOk && !factLossOk)}>承認して検索登録</button>
        </div>
      </div>}
      {published && <p className="admin-summary">登録した内容: {published.title} / {published.aliases.join("・")}（本文 {published.publicText.length}字）</p>}
      {draft.status === "approved" && <p className="input-note">この下書きは登録済みです。修正する場合は、新しい候補を作ってください。</p>}
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

