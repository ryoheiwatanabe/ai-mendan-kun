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

## 画面（ローカル）

~~~
LAB_API_KEY=... npm run serve --prefix experiments/conversation-lab
# または
LAB_API_KEY=... node experiments/conversation-lab/src/server.mts
~~~

http://127.0.0.1:8788/ を開きます。127.0.0.1だけに待ち受け、接続元とHostヘッダの両方でローカル以外を拒否します（外部公開しません）。APIキーはサーバーの環境変数から読み、画面へは渡しません（画面は送信先とモデルだけを表示します）。

画面でできること:

- ケースの選択、質問文の書き換え、送信する根拠の選択（未承認・撤回・非公開・別の人物・旧版は送れません）。
- 「計画を確認」で、送信先・モデル・API呼び出し回数・送信する根拠ID・除外理由を表示（この時点では送信しません）。
- 「実行」で1件ずつ結果が流れます（状態・所要時間・初回トークン・トークン数・回答・不足・除外理由）。「中止」で途中で止められます。
- 結果ごとに人手ラベル（対象一致・項目一致・根拠支持・メモ）を保存。
- 実行記録の一覧と、JSONLの書き出し（非公開の保存先から）。

B/C/Dモードは未実装のため選択できません。Jevは鍵と送信許可が未設定のあいだ not_configured として表示し、Aモードだけが動きます。

## 再試験（A/B/C・同一スナップショット）

指示書2026-09-18の指摘（人物・データ・指示・検証が同時に変わる比較は対照にならない）への対応です。架空1名の同じスナップショットを、現行の取込・検索コードへ読み込んでA/B/Cを回します。

| 条件 | 根拠 | 生成と検証 |
| --- | --- | --- |
| A | ケースが指定した根拠（人が選ぶ） | 短い共通指示・1回生成・形式確認 |
| B | 同じスナップショットを現行の初回検索で取得 | Aと同じ短い指示 |
| C | Bで取得した根拠を固定（再検索しない） | 現行の生成・機械確認・校閲・修復 |

~~~
node experiments/conversation-lab/src/cli.mts retest --cases M01,M06 --conditions A,B,C --repeat 1 --dry-run
node experiments/conversation-lab/src/cli.mts retest --repeat 3 --order interleave
~~~

記録は .local/conversation-lab/retest.jsonl（公開対象外）へ1条件実行1行で追記します。主な項目は、条件・反復・実行順・質問と履歴全文・照応先・対象時期・期待状態・必須/許容/禁止・根拠参照と実ID・manifest（baseSha・スナップショットhash・提供先・モデル・プロンプト版2種・埋め込みの代用方法）・execution_status・modelAnswerability・answerStatus・段階の時間・トークン・そしてCの初回候補/機械確認/校閲理由/修復後候補・人手ラベルです。

実験環境の割り切り（manifestのembeddingとretrievalNoteにも記録）:

- SQLiteはアプリの試験と同じインメモリ実装で、migrations（FTS5）を適用します。キーワード検索・Fact選択・融合は現行コードそのままです。
- ベクトル経路は本番のbge-m3＋Vectorizeが無いため、文字bigramのハッシュ埋め込みに置き換えます（意味の近さは本番ほど捉えられません）。
- そのため検索時間は本番と比較できません（ローカルは数ms、本番は検索の通信込みで数百ms）。
- 非公開にする文書は、取込後にvisibilityを切り替えて用意します（取込の入口は公開だけを受け付けるため）。

未実装: 結果の自動集計と人手採点の入力（次の段階）。
### 根拠の受け渡し（4-1の修正）

Aの人手選択・Bの検索結果・Cの固定根拠を、チャンクとFactの共通形式（src/handoff.mts）にそろえました。

- 送信直前に公開・承認・現行版を確認します。チャンクは resolve、Factは現行版の集合で確認するため、Factを落としません。
- 修正前は、Cが resolve でFactを落とし、送信直前の確認もFactを落としていました（レビュー指摘の再現）。
- 実際にモデルへ渡る本文（プロバイダの入力）を記録し、固定根拠の欠落・本文の食い違いを実行記録へ残します。
- モックの提供元を差し込めるようにし、外部APIを呼ばずに受け渡しを検証できます。
## D条件（同一候補への校閲比較・JEV）

保存済みの再試験記録にある候補（初回・修復後）を固定し、同じ候補・根拠・履歴に対して現行校閲とJEV（TypeSafe）の判定を比べます。JEVの結果で回答の採否は変えません（記録のみ、再生成もしません）。

~~~
# 実行前に、送信先・モデル・対象件数・呼び出し上限・保存先を表示する
TYPESAFE_API_KEY=... LAB_API_KEY=... node experiments/conversation-lab/src/jev-cli.mts --cases M03,M04 --limit 4 --dry-run
TYPESAFE_API_KEY=... LAB_API_KEY=... node experiments/conversation-lab/src/jev-cli.mts --cases M03,M04 --limit 4
~~~

- 生成用の LAB_API_KEY とは別に、JEV用は TYPESAFE_API_KEY を使います。値は表示・保存しません。
- JEVの鍵はキーチェーン（service ai-mendan-kun.development.typesafe）へ入れる場合、.local/jev-key-input.py の非表示ダイアログを使います。確認は --check。
- 送信先は https://api.typesafe.ai/v1/systemone で、許可リスト（LAB_JEV_ALLOWED_HOSTS、既定 api.typesafe.ai）のホストだけに接続します。
- 判定項目は6つ（対象一致・項目一致・根拠支持・因果の非創作・範囲の保持・不要な棄権の回避）で、1回のAPIへまとめます。確率・選択・confidenceを区別し、生の値も保持します。
- 記録（既定 .local/conversation-lab/jev.jsonl）には、候補本文・根拠本文・現行校閲の合否と理由・所要時間・usage、JEVの各項目の確率・所要時間・usageを残します。
- 保存済み記録にモデル入力の実測（採用根拠ID）が無い場合は model_input_recorded / saved_evidence_ids_only と engineAdopted を記録し、推測で復元しません。
- 本人原本・実会話は送信しません（架空資料のみ）。本番切替・追加購入・クレジット超過は行いません。

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
