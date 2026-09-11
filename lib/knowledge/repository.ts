import type { Database, Evidence, Fact } from "../types.ts";
import { ftsQuery } from "./text.ts";

type ChunkRow = { id: string; revision_id: string; document_id: string; title: string; content: string; content_hash: string; entities_json: string };
const chunkSelect = `SELECT c.id,c.revision_id,r.document_id,c.title,c.content,c.content_hash,c.entities_json
  FROM knowledge_chunks c
  JOIN knowledge_document_revisions r ON r.id=c.revision_id
  JOIN knowledge_documents d ON d.id=r.document_id`;
const approved = `r.owner_id=? AND d.owner_id=r.owner_id AND c.owner_id=r.owner_id
  AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
  AND d.active_revision_id=r.id`;

export class KnowledgeRepository {
  readonly db: Database;
  readonly ownerId: string;
  constructor(db: Database, ownerId: string) { this.db = db; this.ownerId = ownerId; }

  async hasKnowledge(): Promise<boolean> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_document_revisions r
      JOIN knowledge_documents d ON d.active_revision_id=r.id AND d.id=r.document_id
      WHERE r.owner_id=? AND d.owner_id=? AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'`)
      .bind(this.ownerId, this.ownerId).first<{ count: number }>();
    return Number(row?.count) > 0;
  }

  async keyword(query: string): Promise<Evidence[]> {
    const expression = ftsQuery(query);
    if (!expression) return [];
    const result = await this.db.prepare(`${chunkSelect}
      JOIN knowledge_fts f ON f.chunk_id=c.id
      WHERE ${approved} AND knowledge_fts MATCH ?
      ORDER BY bm25(knowledge_fts) LIMIT 16`).bind(this.ownerId, expression).all<ChunkRow>();
    return result.results.map((row, index) => toEvidence(row, index));
  }

  // Vectorの本文・metadataを使わず、IDから現在のD1本文を取得する。
  async resolve(ids: string[]): Promise<Evidence[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)].slice(0, 32);
    const result = await this.db.prepare(`${chunkSelect} WHERE ${approved} AND c.id IN (${unique.map(() => "?").join(",")})`)
      .bind(this.ownerId, ...unique).all<ChunkRow>();
    return result.results.map(row => toEvidence(row, unique.indexOf(row.id)));
  }

  async facts(): Promise<Fact[]> {
    const result = await this.db.prepare(`SELECT f.*,r.document_id,r.content_hash FROM exact_facts f
      JOIN knowledge_document_revisions r ON r.id=f.revision_id
      JOIN knowledge_documents d ON d.id=r.document_id
      WHERE f.owner_id=? AND r.owner_id=f.owner_id AND d.owner_id=f.owner_id
      AND f.approval_status='approved' AND f.visibility='public'
      AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      AND d.active_revision_id=r.id LIMIT 1000`).bind(this.ownerId).all<Fact>();
    return result.results;
  }

  async revalidate(evidence: Evidence[]): Promise<boolean> {
    if (!evidence.length) return false;
    const chunks = evidence.filter(item => item.kind === "chunk");
    const facts = evidence.filter(item => item.kind === "exact_fact");
    const [validChunks, validFacts] = await Promise.all([
      this.resolve(chunks.map(item => item.id)), facts.length ? this.facts() : Promise.resolve([])
    ]);
    return chunks.every(item => validChunks.some(row => row.id === item.id && row.contentHash === item.contentHash && row.revisionId === item.revisionId))
      && facts.every(item => validFacts.some(row => `fact:${row.id}` === item.id && row.revision_id === item.revisionId && row.statement === item.content));
  }

  // 音声の各送信単位を、ChunkとFactを合わせた1回のSQLで再照合する。
  async revalidateSnapshot(evidence: Evidence[]): Promise<boolean> {
    if (!evidence.length || evidence.length > 10) return false;
    const expected = evidence.map(() => "(?,?,?,?,?)").join(",");
    const row = await this.db.prepare(`WITH expected(id,revision_id,content_hash,content,kind) AS (VALUES ${expected})
      SELECT COUNT(*) AS count FROM expected e WHERE
      (e.kind='chunk' AND EXISTS (
        SELECT 1 FROM knowledge_chunks c
        JOIN knowledge_document_revisions r ON r.id=c.revision_id
        JOIN knowledge_documents d ON d.id=r.document_id
        WHERE ${approved} AND c.id=e.id AND c.revision_id=e.revision_id AND c.content_hash=e.content_hash
      )) OR (e.kind='exact_fact' AND EXISTS (
        SELECT 1 FROM exact_facts f
        JOIN knowledge_document_revisions r ON r.id=f.revision_id
        JOIN knowledge_documents d ON d.id=r.document_id
        WHERE f.owner_id=? AND r.owner_id=f.owner_id AND d.owner_id=f.owner_id
          AND f.approval_status='approved' AND f.visibility='public'
          AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
          AND d.active_revision_id=r.id AND substr(e.id,1,5)='fact:' AND f.id=substr(e.id,6)
          AND f.revision_id=e.revision_id AND f.statement=e.content AND r.content_hash=e.content_hash
      ))`).bind(...evidence.flatMap(item => [item.id, item.revisionId, item.contentHash, item.content, item.kind]), this.ownerId, this.ownerId)
      .first<{ count: number }>();
    return Number(row?.count) === evidence.length;
  }
}

function toEvidence(row: ChunkRow, rank: number): Evidence {
  return { id: row.id, revisionId: row.revision_id, documentId: row.document_id, title: row.title,
    content: row.content, contentHash: row.content_hash, entities: JSON.parse(row.entities_json), kind: "chunk", rank };
}
