import type { Database, Evidence, Fact, SourceVersion } from "../types.ts";
import { ftsQuery } from "./text.ts";
import { containsExcludedContent, emptyContentExclusions, type ContentExclusionPolicy } from "../security/content-exclusions.ts";

type RevisionContent = { revision_title: string; revision_content: string; revision_entities: string; revision_facts: string };
type ChunkRow = RevisionContent & { id: string; revision_id: string; document_id: string; title: string; content: string; content_hash: string; entities_json: string };
export type PublicTerm = { termId: string; canonical: string; aliases: string[]; sourceRevision: string };
const chunkSelect = `SELECT c.id,c.revision_id,r.document_id,c.title,c.content,c.content_hash,c.entities_json,
  d.title AS revision_title,r.content AS revision_content,(SELECT json_group_array(json_object('title',title,'entities',entities_json,'aliases',aliases_json)) FROM knowledge_chunks WHERE revision_id=r.id AND owner_id=r.owner_id) AS revision_entities,
  (SELECT json_group_array(json_object('value',fact_value,'statement',statement,'aliases',aliases_json)) FROM exact_facts WHERE revision_id=r.id AND owner_id=r.owner_id AND approval_status='approved' AND visibility='public') AS revision_facts
  FROM knowledge_chunks c
  JOIN knowledge_document_revisions r ON r.id=c.revision_id
  JOIN knowledge_documents d ON d.id=r.document_id`;
const approved = `r.owner_id=? AND d.owner_id=r.owner_id AND c.owner_id=r.owner_id
  AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
  AND d.active_revision_id=r.id`;

export class KnowledgeRepository {
  readonly db: Database;
  readonly ownerId: string;
  readonly exclusions: ContentExclusionPolicy;
  constructor(db: Database, ownerId: string, exclusions = emptyContentExclusions) {
    this.db = db; this.ownerId = ownerId; this.exclusions = exclusions;
  }

  private allowed(value: unknown): boolean { return !containsExcludedContent(value, this.exclusions); }

  async hasKnowledge(): Promise<boolean> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_document_revisions r
      JOIN knowledge_documents d ON d.active_revision_id=r.id AND d.id=r.document_id
      WHERE r.owner_id=? AND d.owner_id=? AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'`)
      .bind(this.ownerId, this.ownerId).first<{ count: number }>();
    return Number(row?.count) > 0;
  }

  // 引用していない資料の追加・改訂でも、経歴全体の派生概要を無効にする。
  async sourceSet(): Promise<SourceVersion[]> {
    const result = await this.db.prepare(`SELECT d.id AS document_id,r.id AS revision_id,r.content_hash,
      d.title AS revision_title,r.content AS revision_content,(SELECT json_group_array(json_object('title',title,'entities',entities_json,'aliases',aliases_json)) FROM knowledge_chunks WHERE revision_id=r.id AND owner_id=r.owner_id) AS revision_entities,
  (SELECT json_group_array(json_object('value',fact_value,'statement',statement,'aliases',aliases_json)) FROM exact_facts WHERE revision_id=r.id AND owner_id=r.owner_id AND approval_status='approved' AND visibility='public') AS revision_facts
      FROM knowledge_document_revisions r
      JOIN knowledge_documents d ON d.id=r.document_id AND d.active_revision_id=r.id
      WHERE r.owner_id=? AND d.owner_id=?
        AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      ORDER BY d.id COLLATE BINARY,r.id COLLATE BINARY`).bind(this.ownerId, this.ownerId)
      .all<RevisionContent & { document_id: string; revision_id: string; content_hash: string }>();
    return result.results.filter(row => this.allowed(row)).map(row => ({ documentId: row.document_id, revisionId: row.revision_id, contentHash: row.content_hash }));
  }

  async keyword(query: string): Promise<Evidence[]> {
    if (!this.allowed(query)) return [];
    const expression = ftsQuery(query);
    if (!expression) return [];
    const result = await this.db.prepare(`${chunkSelect}
      JOIN knowledge_fts f ON f.chunk_id=c.id
      WHERE ${approved} AND knowledge_fts MATCH ?
      ORDER BY bm25(knowledge_fts) LIMIT 16`).bind(this.ownerId, expression).all<ChunkRow>();
    return result.results.filter(row => this.allowed(row)).map((row, index) => toEvidence(row, index));
  }

  // Vectorの本文・metadataを使わず、IDから現在のD1本文を取得する。
  async resolve(ids: string[]): Promise<Evidence[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)].slice(0, 32);
    const result = await this.db.prepare(`${chunkSelect} WHERE ${approved} AND c.id IN (${unique.map(() => "?").join(",")})`)
      .bind(this.ownerId, ...unique).all<ChunkRow>();
    return result.results.filter(row => this.allowed(row)).map(row => toEvidence(row, unique.indexOf(row.id)));
  }

  async facts(): Promise<Fact[]> {
    const result = await this.db.prepare(`SELECT f.*,r.document_id,r.content_hash,
      d.title AS revision_title,r.content AS revision_content,(SELECT json_group_array(json_object('title',title,'entities',entities_json,'aliases',aliases_json)) FROM knowledge_chunks WHERE revision_id=r.id AND owner_id=r.owner_id) AS revision_entities,
  (SELECT json_group_array(json_object('value',fact_value,'statement',statement,'aliases',aliases_json)) FROM exact_facts WHERE revision_id=r.id AND owner_id=r.owner_id AND approval_status='approved' AND visibility='public') AS revision_facts FROM exact_facts f
      JOIN knowledge_document_revisions r ON r.id=f.revision_id
      JOIN knowledge_documents d ON d.id=r.document_id
      WHERE f.owner_id=? AND r.owner_id=f.owner_id AND d.owner_id=f.owner_id
      AND f.approval_status='approved' AND f.visibility='public'
      AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
      AND d.active_revision_id=r.id LIMIT 1000`).bind(this.ownerId).all<Fact & RevisionContent>();
    return result.results.filter(row => this.allowed(row)).map(({ revision_title: _title, revision_content: _content, revision_entities: _entities, revision_facts: _facts, ...fact }) => fact);
  }

  // 検索用aliasは読みとは限らない。公開本文で名称に対応付けられた読み・別名だけを使う。
  // リクエストごとに現行版を確認し、撤回後の語彙をブラウザーへ再配布しない。
  async publicTerms(): Promise<PublicTerm[]> {
    const result = await this.db.prepare(`${chunkSelect} WHERE ${approved} ORDER BY c.id LIMIT 1000`)
      .bind(this.ownerId).all<ChunkRow>();
    const terms = new Map<string, PublicTerm>();
    for (const row of result.results) {
      if (!this.allowed(row)) continue;
      const entities: unknown = JSON.parse(row.entities_json);
      if (!Array.isArray(entities)) continue;
      for (const canonical of entities) {
        if (typeof canonical !== "string" || canonical.length < 2 || canonical.length > 80 || !this.allowed(canonical)) continue;
        const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`${escaped}[（(](?:読み[：:]?\\s*|別名[：:]\\s*)?([^（）()\\n]{2,80})[）)]`, "gu");
        const aliases = [...row.content.matchAll(pattern)].flatMap(match => {
          const explicit = /[（(](?:読み|別名)[：:]?/u.test(match[0]);
          return explicit || /^[ぁ-んァ-ヶー\s]+$/u.test(match[1]) ? [match[1].trim()] : [];
        }).filter(alias => this.allowed(alias));
        const key = `${row.revision_id}:${canonical}`;
        const previous = terms.get(key);
        terms.set(key, { termId: `${row.revision_id}:term:${terms.size}`, canonical,
          aliases: [...new Set([...(previous?.aliases ?? []), ...aliases])].slice(0, 8), sourceRevision: row.revision_id });
        if (terms.size >= 64) break;
      }
      if (terms.size >= 64) break;
    }
    return [...terms.values()];
  }

  async revalidate(evidence: Evidence[]): Promise<boolean> {
    if (!evidence.length || !this.allowed(evidence)) return false;
    const chunks = evidence.filter(item => item.kind === "chunk");
    const facts = evidence.filter(item => item.kind === "exact_fact");
    const [validChunks, validFacts] = await Promise.all([
      this.resolve(chunks.map(item => item.id)), facts.length ? this.facts() : Promise.resolve([])
    ]);
    return chunks.every(item => validChunks.some(row => row.id === item.id && row.contentHash === item.contentHash && row.revisionId === item.revisionId
      && row.title === item.title && row.content === item.content))
      && facts.every(item => validFacts.some(row => `fact:${row.id}` === item.id && row.revision_id === item.revisionId && row.statement === item.content));
  }

  // 音声の各送信単位を1回のSQLで再照合し、派生概要では全資料集合も同じsnapshotで確認する。
  async revalidateSnapshot(evidence: Evidence[], sourceSet?: SourceVersion[]): Promise<boolean> {
    // 初回検索10件に探索の追加根拠を足しても、同じSQLのsnapshotで確認する。
    // JSONを1つbindし、件数×6のパラメータでD1の上限を超えないようにする。
    if (!evidence.length || evidence.length > 32 || new Set(evidence.map(item => item.id)).size !== evidence.length || !this.allowed(evidence)) return false;
    const expected = JSON.stringify(evidence.map(item => [item.id, item.revisionId, item.contentHash, item.content, item.kind, item.title]));
    const sourcesColumn = sourceSet === undefined ? "" : `, (
      SELECT json_group_array(json_object('documentId',d.id,'revisionId',r.id,'contentHash',r.content_hash,
        'title',d.title,'content',r.content,'entities',(SELECT json_group_array(json_object('title',title,'entities',entities_json,'aliases',aliases_json)) FROM knowledge_chunks WHERE revision_id=r.id AND owner_id=r.owner_id),
        'facts',(SELECT json_group_array(json_object('value',fact_value,'statement',statement,'aliases',aliases_json)) FROM exact_facts WHERE revision_id=r.id AND owner_id=r.owner_id AND approval_status='approved' AND visibility='public')))
      FROM knowledge_document_revisions r
      JOIN knowledge_documents d ON d.id=r.document_id AND d.active_revision_id=r.id
      WHERE r.owner_id=? AND d.owner_id=r.owner_id
        AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
    ) AS sources_json`;
    const row = await this.db.prepare(`WITH expected(id,revision_id,content_hash,content,kind,title) AS (
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),
        json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)
    )
      SELECT COUNT(*) AS count${sourcesColumn}, (
        SELECT json_group_array(json_object('title',d.title,'content',r.content,'entities',(SELECT json_group_array(json_object('title',title,'entities',entities_json,'aliases',aliases_json)) FROM knowledge_chunks WHERE revision_id=r.id AND owner_id=r.owner_id),
        'facts',(SELECT json_group_array(json_object('value',fact_value,'statement',statement,'aliases',aliases_json)) FROM exact_facts WHERE revision_id=r.id AND owner_id=r.owner_id AND approval_status='approved' AND visibility='public')))
        FROM knowledge_document_revisions r JOIN knowledge_documents d ON d.id=r.document_id AND d.owner_id=r.owner_id
        WHERE r.id IN (SELECT revision_id FROM expected)
      ) AS safety_json FROM expected e WHERE
      (e.kind='chunk' AND EXISTS (
        SELECT 1 FROM knowledge_chunks c
        JOIN knowledge_document_revisions r ON r.id=c.revision_id
        JOIN knowledge_documents d ON d.id=r.document_id
        WHERE ${approved} AND c.id=e.id AND c.revision_id=e.revision_id AND c.content_hash=e.content_hash
          AND c.title=e.title AND c.content=e.content
      )) OR (e.kind='exact_fact' AND EXISTS (
        SELECT 1 FROM exact_facts f
        JOIN knowledge_document_revisions r ON r.id=f.revision_id
        JOIN knowledge_documents d ON d.id=r.document_id
        WHERE f.owner_id=? AND r.owner_id=f.owner_id AND d.owner_id=f.owner_id
          AND f.approval_status='approved' AND f.visibility='public'
          AND r.approval_status='approved' AND r.visibility='public' AND r.index_state='indexed'
          AND d.active_revision_id=r.id AND substr(e.id,1,5)='fact:' AND f.id=substr(e.id,6)
          AND f.revision_id=e.revision_id AND f.statement=e.content AND r.content_hash=e.content_hash
      ))`).bind(expected,
        ...(sourceSet === undefined ? [] : [this.ownerId]), this.ownerId, this.ownerId)
      .first<{ count: number; sources_json?: string; safety_json?: string }>();
    if (Number(row?.count) !== evidence.length) return false;
    if (typeof row?.safety_json !== "string" || !this.allowed(JSON.parse(row.safety_json))) return false;
    if (sourceSet === undefined) return true;
    if (typeof row?.sources_json !== "string") return false;
    let current: unknown;
    try { current = JSON.parse(row.sources_json); } catch { return false; }
    if (Array.isArray(current)) current = current.filter(item => this.allowed(item));
    if (!Array.isArray(current) || current.length !== sourceSet.length) return false;
    const versions = new Map<string, SourceVersion>();
    for (const item of current) {
      if (!item || typeof item.documentId !== "string" || typeof item.revisionId !== "string" || typeof item.contentHash !== "string") return false;
      versions.set(item.documentId, item);
    }
    if (versions.size !== sourceSet.length || new Set(sourceSet.map(item => item.documentId)).size !== sourceSet.length) return false;
    return sourceSet.every(item => {
      const version = versions.get(item.documentId);
      return version?.revisionId === item.revisionId && version.contentHash === item.contentHash;
    });
  }
}

function toEvidence(row: ChunkRow, rank: number): Evidence {
  return { id: row.id, revisionId: row.revision_id, documentId: row.document_id, title: row.title,
    content: row.content, contentHash: row.content_hash, entities: JSON.parse(row.entities_json), kind: "chunk", rank };
}
