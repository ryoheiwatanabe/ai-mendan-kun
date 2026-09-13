"use client";

import { useEffect, useState } from "react";
import { observeTestRecording, type TestRecordingStatus } from "../lib/test-recording.ts";

export function useTestRecording() {
  const [status, setStatus] = useState<TestRecordingStatus>({ enabled: false, healthy: true });
  useEffect(() => observeTestRecording(setStatus), []);
  return status;
}

export function TestRecordingNotice({ status }: { status: TestRecordingStatus }) {
  if (!status.enabled) return null;
  return <p className={status.healthy ? "input-note" : "error-message"} role={status.healthy ? "status" : "alert"}>
    {status.healthy ? "検証記録をこのMacに保存中：会話・マイク音声・生成音声・エラー・応答時間。終了や再読み込み後も残ります。"
      : "検証記録を保存できません。記録用プレビューの接続と保存先を確認してください。"}
  </p>;
}

export function ConversationStorageDescription({ processors }: { processors: string }) {
  const status = useTestRecording();
  return <>
    <h2>{status.enabled ? "この検証画面の会話を記録します。" : "このサービスでは会話本文を保存しません。"}</h2>
    <TestRecordingNotice status={status} />
    <p>{status.enabled ? "検証中の会話本文、聞き取り前のマイク音声、AIの生成音声と処理記録は、このMacの開発用フォルダーに保存します。終了・画面を閉じる・再読み込みでは削除しません。公開用の回答資料には自動追加しません。"
      : "会話はこのタブのメモリに保持し、次の質問と一緒に必要な範囲を送信します。会話を終了するかページを閉じると破棄されます。"}
      処理にはCloudflareと{processors}を利用するため、質問・必要な会話履歴・参照情報は処理のため各サービスへ送られます。</p>
    <p>通常の公開版では会話本文や根拠の抜粋を永続保存しません。不正利用を防ぐため、内容を含まない利用回数を短期間保持します。外部API側の保持条件は提供元のポリシーに従います。</p>
  </>;
}
