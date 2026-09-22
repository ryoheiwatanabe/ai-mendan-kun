import type { Metadata } from "next";
import Link from "next/link";
import { IntakePanel } from "../../../components/intake-panel";

// 検索結果へ出さない。鍵がなければ読み書きできない。
export const metadata: Metadata = { title: "公開用資料を整える | AI面談くん", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function IntakeAdmin() {
  return <main className="admin-page"><Link className="text-link" href="/admin">← 採点設定へ戻る</Link>
    <h1>公開用資料を整える</h1>
    <p className="input-note">本人専用の画面です。原文→公開用候補→本人の編集・承認→検索登録までを行います。</p>
    <IntakePanel />
  </main>;
}
