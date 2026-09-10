# AI回答を動かすセットアップ

[READMEへ戻る](../../README.md)。ローカル画面の起動後に、CloudflareとAI APIを設定し、自分が公開用に承認したデータを投入する手順です。APIキーや本人資料はリポジトリへ含めません。

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
```

承認操作はEmbedding API費用を伴います。Index反映後にD1の現行版を切り替え、途中失敗なら旧承認版を維持します。

投入後は、`wrangler deploy`の結果に表示されたWorkerのURLを開き、承認した内容について質問して確認します。`http://127.0.0.1:3000`の開発画面は、本番のBindings・Secret・本人データへ自動接続しません。

**公開を取り消すときのみ**、対象のRevision IDを指定して次を実行します。初回投入時には実行しません。

```sh
npm run knowledge:revoke -- <取り消すrev_ID>
```

公開取り消しはD1を先に変更するため、Vector削除が失敗しても回答対象から外れます。取り消した版を再承認せず、確認した新しい版を用意します。

管理操作は公開HTTP APIにありません。`KnowledgeAdmin`という名前付きRPCを、認証されたローカルWranglerから呼びます。`wrangler.admin.jsonc`はローカル専用で公開デプロイしません。作業終了時に管理ブリッジを止めます。Workerの再デプロイやSecret更新後は、古い接続を使わないよう管理ブリッジを再起動してください。

## 実APIの評価

`scripts/golden.ts`で、本人が確認した10〜20問の評価セットを実APIへ送信できます。セットには期待事実・禁止主張・非公開情報・続きの質問・誤前提・履歴改変などを含め、質問と送信範囲を所有者が承認してから`approvedForEvaluation`を`true`にします。

```sh
npm run golden -- data/drafts/golden.json https://<WorkerのURL> --allow-api-cost
```

実API費用が発生します。標準出力にはCase ID・合否・回答可否・所要時間だけを返し、会話本文は保存しません。HTTPエラーは追加の呼び出しを止めます。文字列による評価だけでなく、本人による意味・限定・自然さの確認も必要です。実際の評価データや結果はGitへ含めません。
