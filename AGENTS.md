# このプロジェクトのGit運用

- 通常の変更は最新の`main`から作業ブランチを作り、意味のある変更単位でcommit・pushする。`main`への直接push、force push、共有済み履歴の書き換えを行わない。
- PRには変更目的、変更ファイル、挙動の変化、重点確認箇所、実施した検証と結果、残る制約を書く。詳細は`docs/development_workflow/README.md`。
- 差分に合った確認とレビューを行い、問題がなければPRをSquash and mergeする。通常の可逆な変更は依頼範囲内でマージまで進め、ユーザーのレビュー待ち指定がある場合は従う。
- マージ直前にPRの最新commit、確認結果、未解決の指摘を照合する。追加commit後は影響を受ける確認をやり直す。終了したブランチを次の作業へ使い回さない。
- 人による確認とAIによる確認を区別する。未実施のテストやレビューを完了と書かない。本人の判断とAIの実装・操作の分担を誇張しない。
- `data/`、`docs/project_context/`、`wrangler.jsonc`、`.local/`、認証情報、環境ファイルはcommitしない。`.gitignore`の除外を`git add -f`で回避しない。PR本文・コメント・添付にも個人情報やSecretを含めない。
- `.env`とその派生ファイルは作成・編集・引き渡しをしない。実設定はGit対象外の`wrangler.jsonc`、共有設定は`wrangler.template.jsonc`、アプリSecretはWorkers Secretsを使う。
- アプリの本番反映はマージとは別に確認する。新たな課金、公開範囲の拡大、権限追加、個人データの公開など、既存の承認を超える操作は実行前に本人へ確認する。
- このリポジトリでは当面ローカルで検証する。GitHub Actions等の自動実行を追加する場合は、費用・権限・送信するデータを先に確認する。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
