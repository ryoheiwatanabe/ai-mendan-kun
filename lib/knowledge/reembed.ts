import type { Database, EmbeddingProvider } from "../types.ts";
import { visibleVectorIds, type WritableVectorIndex } from "./import.ts";
import { containsExcludedContent, emptyContentExclusions, type ContentExclusionPolicy } from "../security/content-exclusions.ts";

// 承認済みの現行版だけを、いま設定されている埋め込みで作り直す。
// chunk idは本文のハッシュから決まるため、同じidへ上書きし、前のモデルのベクトルを残さない。
// 署名は最後に切り替える。途中で止まれば署名が一致しないままなので、混ざった検索結果は返らない。
export async function reembedActiveRevisions(input: {
  db: Database; vector: WritableVectorIndex; embedding: EmbeddingProvider; ownerId: string;
  signature: string; signal: AbortSignal;
  exclusions?: ContentExclusionPolicy;
}) {
  const { db, vector, embedding, ownerId, signature, signal } = input;
  const rows = await db.prepare(`SELECT c.id,c.revision_id,c.title,c.content,c.entities_json,c.aliases_json,
    r.content AS revision_content,d.title AS document_title FROM knowledge_chunks c
    JOIN knowledge_document_revisions r ON r.id=c.revision_id
    JOIN knowledge_documents d ON d.id=r.document_id
    WHERE r.owner_id=? AND d.owner_id=r.owner_id AND c.owner_id=r.owner_id
      AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      AND d.active_revision_id=r.id`).bind(ownerId)
    .all<{ id: string; revision_id: string; title: string; content: string; entities_json: string; aliases_json: string; revision_content: string; document_title: string }>();
  const excludedRevisions = new Set(rows.results.filter(row => containsExcludedContent(row, input.exclusions ?? emptyContentExclusions)).map(row => row.revision_id));
  const chunks = rows.results.filter(row => !excludedRevisions.has(row.revision_id));
  if (!chunks.length) throw new Error("再Embeddingの対象がありません。");
  const vectors = [];
  for (const chunk of chunks) {
    signal.throwIfAborted();
    // 承認時の登録と同じ本文（見出し＋本文）を渡す。
    vectors.push({ id: chunk.id, values: await embedding.embed(`${chunk.title}\n${chunk.content}`, signal, "document"),
      metadata: { ownerId, visibility: "public", revisionId: chunk.revision_id } });
  }
  await vector.upsert(vectors);
  const ids = chunks.map(chunk => chunk.id);
  let indexed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted();
    const visible = await visibleVectorIds(vector, ids);
    if (ids.every(id => visible.has(id))) { indexed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!indexed) throw new Error("Vectorizeの反映待ちです。署名は切り替えていません。");
  signal.throwIfAborted();
  await db.prepare(`INSERT INTO knowledge_index_configuration(owner_id,embedding_signature) VALUES(?,?)
    ON CONFLICT(owner_id) DO UPDATE SET embedding_signature=excluded.embedding_signature`).bind(ownerId, signature).run();
  return { status: "reembedded", chunks: ids.length, signature };
}
