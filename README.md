# AI面談くん — Phase 1 P0

本人が公開用に承認した情報を検索し、面談前の疑問に答える文字チャットです。Next.js・Cloudflare Workers / D1 / Vectorizeを使用し、回答と検索用EmbeddingのProviderを分離しています。

このリポジトリにはアプリ本体、テスト、設定テンプレート、再現手順を収録しています。本人のプロフィール・履歴書・承認記録、会話、認証情報、実環境の設定は含めません。既存のデータベースへ接続せず、手元の設定と本人が承認したデータを用意して利用します。

## 実装範囲

- 単一チャット入口、ストリーミング表示、回答停止、入力復元、日本語IME対応。
- 待機表示は「思い出しています…」。質問候補は常に3件表示し、18件から回答完了ごとに巡回。候補の入れ替えにはAPIを使用しません。
- D1の日本語bigram FTS、Exact Facts、Vectorizeによる検索を並列実行し、順位を統合。
- `approved + active + public + indexed + owner一致`をD1で確認。Vector metadataを公開許可や本文の根拠にしません。
- 文書の版ごとの下書き・承認・差し替え・公開取り消し。承認ハッシュは本文・検索語・事実・期間・公開範囲を含みます。
- Unknown / Partial / Ambiguousと、数値・担当範囲・但し書きを保持する表示前照合。
- Gemini / OpenAIの回答・Embedding Adapter。別Providerへ失敗時に自動fallbackしません。
- 会話本文の非保存、入力上限、Prompt Injection対策、匿名の利用回数制限。

管理画面、Notion同期、質問箱、Feedback、永続会話ログ、音声、映像は対象外です。

## ローカル起動

Node.js 22.18以上とnpmを使用します。

```sh
npm ci
cp -n wrangler.template.jsonc wrangler.jsonc
npm run dev
```

`http://127.0.0.1:3000`で画面を確認します。`wrangler.jsonc`はGit対象外のローカル実設定です。既にある設定をテンプレートで上書きしないでください。テンプレートのDB UUIDは未設定を示すゼロ値です。Bindings・Secret・承認済みデータが未設定なら、質問に実AIの回答は返りません。

```sh
npm test
npm run typecheck
npm run test:e2e
npm run build:worker
```

ブラウザテストは既存のGoogle Chromeを使用します。Chromeがない環境は、インストールの可否を確認してからテスト環境を用意してください。UIテストの通信はテスト内で置き換えており、実AI APIの課金は発生しません。

2026-09-10時点で、コアテスト48件、Chromeの画面テスト10件、型チェックを含むWorkerビルドが通過しています。320 / 375 / 414 / 768 / 1440pxの表示、3往復後の候補表示、失敗時の入力復元、IME、会話終了・再読込時の破棄を確認しています。実AIの回答品質は、利用者自身の承認済みデータで別途評価してください。

## Cloudflareの設定

設定テンプレートをコピーした後、自分のCloudflareアカウントで認証し、Workers・D1・Vectorizeを用意します。無料プランでの動作確認実績はありますが、利用量と現行の上限・料金を確認してください。有料化や利用制限の拡大は費用への影響を確認して行います。

```sh
npx wrangler login
npx wrangler d1 create ai-mendan-kun
npx wrangler vectorize create ai-mendan-kun --dimensions=1536 --metric=cosine
npx wrangler vectorize create-metadata-index ai-mendan-kun --property-name=ownerId --type=string
npx wrangler vectorize create-metadata-index ai-mendan-kun --property-name=visibility --type=string
```

D1の作成結果にあるUUIDをローカルの`wrangler.jsonc`へ設定します。リソース名を変更した場合は、`wrangler.jsonc`と`wrangler.admin.jsonc`のservice名も合わせます。既存のリソースは再作成しません。

```sh
npx wrangler d1 migrations apply ai-mendan-kun --remote
npm run build:worker
npx wrangler deploy
npx wrangler secret put GEMINI_API_KEY
```

APIキーは非表示入力でWorkers Secretへ登録します。`.env`、その派生ファイル、`.dev.vars`は作成しません。キーをソース、シェル引数、ログ、チャットへ貼り付けないでください。

テンプレートは回答に`gemini-3.8-flash`、Embeddingに`gemini-embedding-2`（1536次元）を指定しています。通常設定は`wrangler.jsonc`、秘密値はWorkers Secretsから読みます。1日100要求・IPごと1時間30要求が初期値です。`GET /api/health`はHTTPプロセスの生存確認であり、AIやデータ接続の成功を保証しません。

回答をOpenAIへ変更する場合は`OPENAI_API_KEY`を登録し、`ANSWER_PROVIDER=openai`、`ANSWER_MODEL=gpt-4.1-mini`等、Adapterと互換性のあるモデルを指定して再デプロイします。Embeddingを維持すれば本文の再登録は不要です。送信先・APIの料金・データ利用条件を確認して切り替えてください。

Embeddingの変更は、新しいVectorize indexで承認済みデータを再Embeddingし、D1のindex構成と現行版を整合させてから行います。P0には一括移行の自動化はありません。他社APIは`lib/ai/providers.ts`へAdapterを追加する構成です。

macOSでTokenを非表示入力し、キーチェーンで管理する補助CLIは`scripts/cloudflare-session.py`です。`start --keychain`は対象アカウント単位の作業Tokenを新規作成・保存するため、権限と保存先を理解した所有者が使用します。既存Tokenを使う場合は`resume`です。通常のWrangler認証でも作業できます。

## 本人データの投入

`examples/knowledge.template.json`と`examples/public-profile.md`を`data/drafts/`へコピーし、本文とmanifestを用意します。テンプレートをそのまま承認・投入しないでください。`data/`全体はGit対象外です。

1文書40,000文字、最大24 Chunk・12 Exact Facts、1段落800文字以内です。数字の時点、否定、但し書き、本人の担当範囲を同じ段落へ残します。自己申告と外部裏づけは区別し、自己申告は`verification: self_reported`を使います。

Exact Factは`id / key / value / statement / aliases`を指定します。`statement`は本文の完全な段落と一致させ、対象期間を`validFrom / validTo`で指定します。訂正は同じ文書内のFact IDを`supersedesFactId`で参照します。

```sh
npm run knowledge:prepare -- data/drafts/profile.json
```

`data/reviews/`へ全文・事実・検索語・承認ハッシュを出力します。この段階ではAPIも公開承認も実行しません。本人が全文と公開範囲を確認してから承認します。

```sh
# 別ターミナルで、認証済みのローカル管理ブリッジを起動
npm run admin:dev

# ハッシュ省略時はD1へdraft保存のみ
npm run knowledge:import -- data/drafts/profile.json

# 本人確認後、プレースホルダーを確認済みの値へ置き換えて実行
npm run knowledge:import -- data/drafts/profile.json --approve-hash <確認済みハッシュ>
npm run knowledge:revoke -- <rev_ID>
```

承認操作はEmbedding API費用を伴います。Index反映後にD1の現行版を切り替え、途中失敗なら旧承認版を維持します。公開取り消しはD1を先に変更するため、Vector削除が失敗しても回答対象から外れます。取り消した版を再承認せず、確認した新しい版を用意します。

管理操作は公開HTTP APIにありません。`KnowledgeAdmin`という名前付きRPCを、認証されたローカルWranglerから呼びます。`wrangler.admin.jsonc`はローカル専用で公開デプロイしません。作業終了時に管理ブリッジを止めます。Workerの再デプロイやSecret更新後は、古い接続を使わないよう管理ブリッジを再起動してください。

## 実APIの評価

`scripts/golden.ts`で、本人が確認した10〜20問の評価セットを実APIへ送信できます。セットには期待事実・禁止主張・非公開情報・続きの質問・誤前提・履歴改変などを含め、質問と送信範囲を所有者が承認してから`approvedForEvaluation`を`true`にします。

```sh
npm run golden -- data/drafts/golden.json https://<WorkerのURL> --allow-api-cost
```

実API費用が発生します。標準出力にはCase ID・合否・回答可否・所要時間だけを返し、会話本文は保存しません。HTTPエラーは追加の呼び出しを止めます。文字列による評価だけでなく、本人による意味・限定・自然さの確認も必要です。実際の評価データや結果はGitへ含めません。

## プライバシーと共有範囲

会話はブラウザのタブのメモリに保持し、終了・再読込・タブを閉じると破棄します。直近6往復・合計5,500文字までの履歴を文脈として送り、履歴を本人の事実の根拠にはしません。停止・失敗した回答は次の質問の履歴から除きます。

質問・履歴・公開Evidenceは、処理に必要な範囲でCloudflareと設定したAI Providerへ送信します。アプリ内の非保存と外部事業者の保持条件は別です。Cloudflare observabilityは初期状態で無効、OpenAIには`store: false`を指定し、GeminiはステートレスなAPIを使用します。

利用制限用D1には、日ごとに変わるIP由来のhash・回数・失効時刻を保存し、生IPや本文は保存しません。期限切れ行は次回アクセス時に削除します。アクセスがなければ期限後も行自体は残ります。

Gitへ含めないもの：

- `data/`：本人資料、投入データ、承認・評価ファイル。
- `docs/project_context/`：個別案件の判断記録・運用手順。
- `wrangler.jsonc`：実環境の設定。共有用は`wrangler.template.jsonc`。
- `.local/`、ビルド出力、画面テストの出力、認証情報、環境ファイル。

新しいファイルを追加する際も、コミット対象に個人情報や認証情報がないことを確認してください。`.gitignore`は既にコミットした内容を消す機能ではありません。

## 既知の制約

- 事実文は承認済みの完全な段落を選ぶ方式で、回答が長く硬くなる場合があります。
- AIの解釈は明示的に適性・相性等を尋ねた場合だけラベル付きで許可します。意味的な妥当性を文字列の照合だけで保証できません。
- Exact Factsは現在・単年・明示日付を扱います。複数期間の比較や月単位の変化は未拡張です。
- 日本語bigramと意味検索の重み・しきい値は、利用者のデータで評価する必要があります。
- Rate limitは費用削減の補助です。分散攻撃や同じネットワークの利用者を完全には区別できません。
- 実APIのトークン数は現在、画面やDBへ記録していません。利用料は提供元の請求情報で確認します。

参考：[OpenNext](https://opennext.js.org/cloudflare)、[Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)、[Vectorize](https://developers.cloudflare.com/vectorize/reference/client-api/)、[Gemini料金とデータ条件](https://ai.google.dev/gemini-api/docs/pricing)。
