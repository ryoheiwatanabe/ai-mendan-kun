# 改修前の比較テスト（conversation lab）

仕様: [docs/experiments/pre-refactor-conversation-lab.md](../../docs/experiments/pre-refactor-conversation-lab.md)（版1.0）

「どの段階が品質と速度を悪化させているか」を切り分けるための、本番から独立したローカル検証用プロダクトです。本番バンドル・本番設定・公開サイトには含めません。

## いま入っているもの（Phase 1）

- 完全な架空の資料（data/fictional-profile.json）と架空ケース（data/cases.json、data/histories.json）。
- Aモード: 人が選んだ根拠を固定し、短い指示で1回だけ生成する。検索・LLM校閲・修復は行わない。
- 実行前の表示（送信先・モデル・件数・API呼び出し回数・送信する根拠ID・除外した根拠と理由）。
- 段階の時刻（API開始・初回トークン・完了・合計）とusageの記録。取得できない値はnullのままにし、推定で埋めない。
- 人手ラベル（対象一致・項目一致・根拠支持・メモ）と、公開対象外のJSONLへの保存。
- 通信しない範囲の試験（tests/lab.test.mts）。

## 実行方法

~~~
# 送信内容の確認（APIを呼ばない）
node experiments/conversation-lab/src/cli.mts plan --cases T01,T10

# 実行（1ケース1回の生成。結果は .local/conversation-lab/records.jsonl へ保存）
LAB_API_KEY=... node experiments/conversation-lab/src/cli.mts run --cases T01,T02

# 記録の確認
node experiments/conversation-lab/src/cli.mts list --limit 10
node experiments/conversation-lab/src/cli.mts stats

# 人手ラベル
node experiments/conversation-lab/src/cli.mts label --run <runId> --target ok --aspect ok --supported ng --notes TEXT
~~~

環境変数:

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| LAB_API_KEY | なし（runでは必須） | 提供元のキー。表示・保存しない |
| LAB_BASE_URL | https://opencode.ai/zen/go/v1 | OpenAI互換の接続先 |
| LAB_MODEL | glm-5.3-flash | 比較するモデル |
| LAB_SESSION | ai-mendan-kun-lab | 接続先が要求するセッション識別子 |
| LAB_ALLOWED_HOSTS | opencode.ai | 接続を許可するホスト（カンマ区切り）。ここに無いホストへは接続しない |
| LAB_RECORDS | .local/conversation-lab/records.jsonl | 記録の保存先（公開対象外） |

試験: cd experiments/conversation-lab してから npm test（Node 22以降。型の付いた.mtsをそのまま実行する）

補足: T13は配線の確認用に、意図的に短いタイムアウトで失敗させるケースです。失敗が1件あるとCLIは終了コード1を返します（--allow-errors で0にできます）。

## 守っていること

- 公開リポジトリには仕様・汎用コード・架空資料だけを置く。本人原本・実会話・実回答・鍵は置かない。
- 採点用のgold（mustInclude / mustNot）は生成の入力へ渡さない（試験で固定）。
- 承認済み・公開・対象者一致・現行版の根拠だけをモデルへ渡し、使えない理由（未承認・撤回・非公開・別の人物・旧版）を記録に残す。
- タイムアウトやHTTPエラーは処理失敗として記録し、情報不足として扱わない。
- 接続先は許可リストで固定する。手入力のURLへは接続しない。

## まだ無いもの

- B（現行検索）、C（固定根拠で現行の生成・校閲を再現）、D（同一候補へのJevと現行校閲の比較）、E（ルーティング比較）。
- ローカル画面（現在はCLIのみ）。
- 実APIでの本格的な実行（現在は少数ケースの配線確認まで）。

## 記録の形

1行1実行のJSONLです。主な項目: runId, at, baseSha, mode, caseId, question, historyId, selection, sentEvidenceIds, excluded, provider, model, temperature, maxTokens, promptVersion, status, errorKind, answer, sourceIds, limitations, timing, usage, apiCalls, label。
