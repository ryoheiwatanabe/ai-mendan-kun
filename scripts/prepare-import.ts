import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readImport, reportError } from "./import-file.ts";

try {
  const path = process.argv[2];
  if (!path) throw new Error("使用方法: npm run knowledge:prepare -- <manifest.json> [review.md]");
  const prepared = await readImport(path);
  const output = resolve(process.argv[3] || `data/reviews/${prepared.revisionId}.md`);
  if (!output.endsWith(".md")) throw new Error("レビュー出力は.mdを指定してください。");
  const { bundle } = prepared;
  const review = `# 公開回答用文書の確認\n\nこれは公開承認前の候補です。\n\n- 文書: ${bundle.title}\n- Owner: ${bundle.ownerId}\n- Revision: ${prepared.revisionId}\n- 承認ハッシュ: ${prepared.hash}\n- 裏づけ区分: ${bundle.verification}\n- 公開範囲: public\n- Chunk数: ${prepared.chunks.length}\n\n## 確認する本文（全文）\n\n${bundle.content}\n\n## Exact Factsと検索語\n\n\`\`\`json\n${JSON.stringify(bundle.facts, null, 2)}\n\`\`\`\n\n## 固有名詞\n\n${bundle.entities.join("、") || "指定なし"}\n\n## 承認時の操作\n\n元のJSONと本文を確認したうえで、knowledge:importへ上記のハッシュを明示します。変更があればこのレビューを再生成してください。\n`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, review, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ review: output, revisionId: prepared.revisionId, hash: prepared.hash, chunks: prepared.chunks.length }, null, 2));
} catch (error) { reportError(error); }
