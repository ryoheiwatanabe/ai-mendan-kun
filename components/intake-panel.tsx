"use client";

import { useState } from "react";
import { ADMIN_HEADER } from "../lib/security/admin.ts";

type IntakeOmitted = { item: string; reason: string };
type DraftView = { id: string; status: "draft" | "held" | "approved" | "rejected"; title: string; publicText: string;
  aliases: string[]; topic: string; kept: string[]; omitted: IntakeOmitted[]; questions: string[]; model: string;
  promptVersion: string; approvedRevisionId: string | null; createdAt: string; updatedAt: string; approvalHash?: string;
  sourceId?: string };
type SourceView = { id: string; title: string; contentHash: string; replacesRevisionId: string | null; createdAt: string; rawText?: string };
type PublicDocument = { documentId: string; revisionId: string; title: string };
type Payload = { sources?: SourceView[]; drafts?: DraftView[]; publicDocuments?: PublicDocument[];
  provider?: { label: string; model: string; promptVersion: string }; error?: { code?: string; message?: string } };

// 公開用資料を整える（#5）。原文→候補→本人の編集・承認→検索登録までを1画面で行う。
export function IntakePanel() {
  const [token, setToken] = useState("");
  const [server, setServer] = useState<Payload | null>(null);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [replaces, setReplaces] = useState("");
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(method: "GET" | "POST", body?: unknown) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/intake", { method, headers: { [ADMIN_HEADER]: token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json() as Payload & { draft?: DraftView; usage?: { input: number; output: number } };
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
  async function prepare() {
    const payload = await call("POST", { action: "prepare", title, rawText, replacesRevisionId: replaces || undefined });
    if (!payload?.draft) return;
    setDraft(payload.draft); setSource((server?.sources ?? []).find(item => item.id === payload.draft!.sourceId) ?? null);
    setNotice("公開用候補を作りました。原文と候補を確認して、必要なら直してください。");
    await load();
  }
  async function save(action: "save" | "hold" | "approve" | "reject") {
    if (!draft) return;
    if (action === "approve" && !window.confirm("表示中の公開用本文と検索語で、検索へ登録します。よろしいですか。")) return;
    const payload = await call("POST", { action, draftId: draft.id, title: draft.title, publicText: draft.publicText,
      aliases: draft.aliases, topic: draft.topic, ...(action === "approve" ? { approvalHash: draft.approvalHash } : {}) });
    if (!payload?.draft) return;
    setDraft(payload.draft);
    setNotice(action === "approve" ? "公開版を検索へ登録しました。本体で質問できます。" : action === "hold" ? "非公開のまま保留しました。" : action === "reject" ? "却下しました。公開はしていません。" : "下書きを保存しました。");
    await load();
  }

  return <section className="intake-panel">
    <h2>公開用資料を整える</h2>
    <p className="input-note">生の内省メモを、面談相手に見せてよい公開用の知識カードへ整えます。原文は管理用の保存先にだけ残り、公開検索へは公開用の本文と検索語だけを登録します。</p>
    <div className="admin-token">
      <label htmlFor="intake-token">管理用の鍵</label>
      <input id="intake-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
      <div className="admin-actions"><button type="button" onClick={load} disabled={busy || !token}>読み込む</button></div>
    </div>
    {error && <p role="alert" className="error-message">{error}</p>}
    {notice && <p className="admin-summary">{notice}</p>}
    {server?.provider && <p className="admin-note">候補づくりに使う送信先: {server.provider.label || "未設定"} / モデル {server.provider.model || "未設定"} / 指示の版 {server.provider.promptVersion}。送るのは、下に貼り付けた原文だけです。</p>}

    <h2>1. 原文を選ぶ</h2>
    <div className="admin-fields">
      <label>文書名（公開カードの見出し）
        <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
      <label>置換する既存の公開版（任意）
        <select value={replaces} onChange={event => setReplaces(event.target.value)}>
          <option value="">置換しない（新しいカードとして追加）</option>
          {(server?.publicDocuments ?? []).map(item => <option key={item.revisionId} value={item.revisionId}>{item.title}（{item.revisionId.slice(0, 12)}…）</option>)}
        </select><small className="admin-note">選ぶと、承認後に旧版を撤回して置き換えます。承認までは旧版を消しません</small></label>
    </div>
    <label className="admin-note" htmlFor="intake-source">原文（この本文が変換の送信対象です）</label>
    <textarea id="intake-source" className="intake-source" value={rawText} maxLength={20000} rows={8}
      placeholder="本人の内省メモや面談の記録を貼り付けます。この原文は公開されません。"
      onChange={event => setRawText(event.target.value)} />
    <div className="admin-actions">
      <button type="button" onClick={prepare} disabled={busy || !token || title.trim().length === 0 || rawText.trim().length < 20}>公開用候補を作る</button>
    </div>

    {draft && <div className="intake-review">
      <h2>2. 候補を確認して直す</h2>
      <p className="admin-note">状態: {draft.status === "draft" ? "下書き" : draft.status === "held" ? "保留中" : draft.status === "approved" ? "登録済み" : "却下"} / モデル {draft.model || "未設定"} / 指示の版 {draft.promptVersion}</p>
      {source && <details className="intake-original"><summary>原文を表示（公開しません）</summary><pre>{source.rawText}</pre></details>}
      <div className="admin-fields">
        <label>公開用の本文
          <textarea className="intake-public" rows={8} value={draft.publicText} maxLength={8000}
            onChange={event => setDraft({ ...draft, publicText: event.target.value })} /></label>
        <label>検索語（カンマ区切り・1〜12件）
          <input value={draft.aliases.join(", ")} onChange={event => setDraft({ ...draft, aliases: event.target.value.split(",").map(item => item.trim()).filter(Boolean) })} /></label>
        <label>分類（例: work_values）
          <input value={draft.topic} maxLength={40} onChange={event => setDraft({ ...draft, topic: event.target.value })} /></label>
      </div>
      <ul className="admin-samples">
        <li><span className="admin-sample-kind">残した要点</span><span className="admin-sample-result">{draft.kept.join(" / ") || "（なし）"}</span></li>
        <li><span className="admin-sample-kind">省略した内容</span><span className="admin-sample-result">{draft.omitted.map(item => item.item + "（" + item.reason + "）").join(" / ") || "（なし）"}</span></li>
        <li><span className="admin-sample-kind">要確認</span><span className="admin-sample-result">{draft.questions.join(" / ") || "（なし）"}</span></li>
      </ul>
      <div className="admin-actions">
        <button type="button" onClick={() => save("save")} disabled={busy}>下書き保存</button>
        <button type="button" onClick={() => save("hold")} disabled={busy}>非公開のまま保留</button>
        <button type="button" onClick={() => save("approve")} disabled={busy || draft.status === "approved"}>承認して検索登録</button>
        <button type="button" onClick={() => save("reject")} disabled={busy || draft.status === "approved"}>却下する</button>
      </div>
      <p className="input-note">承認すると、公開用の本文と検索語だけをまとめた文書として登録し、本文の照合と索引づくりが終わってから本体で答えられるようになります。原文・省略メモ・要確認は登録しません。</p>
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
          setDraft(found);
          setSource((payload.sources ?? []).find(entry => entry.id === found?.sourceId) ?? null);
        }}>開く</button>
      </li>)}
      {!(server?.drafts ?? []).length && <li><span className="admin-sample-result">まだありません。</span></li>}
    </ul>
  </section>;
}
