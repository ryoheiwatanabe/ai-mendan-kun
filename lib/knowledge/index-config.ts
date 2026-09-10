import type { Database } from "../types.ts";

// 回答用モデルを切り替えても検索空間は維持する。違う埋め込みを混在させない。
export async function assertEmbeddingSignature(db: Database, ownerId: string, signature: string, initialize = false) {
  if (initialize) await db.prepare(`INSERT INTO knowledge_index_configuration(owner_id,embedding_signature)
    SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM knowledge_document_revisions WHERE owner_id=? AND approval_status='approved')
    ON CONFLICT(owner_id) DO NOTHING`).bind(ownerId, signature, ownerId).run();
  const row = await db.prepare("SELECT embedding_signature FROM knowledge_index_configuration WHERE owner_id=?").bind(ownerId).first<{ embedding_signature: string }>();
  if (!row || row.embedding_signature !== signature) throw new Error("embedding_index_mismatch");
}
