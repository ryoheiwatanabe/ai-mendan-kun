// 同一スナップショットを、現行の取込・検索コードで読み込む実験用の土台。
// SQLiteはアプリの試験と同じインメモリ実装（migrations適用・FTS5あり）を使う。
// ベクトル経路だけは本番の埋め込み（Workers AI bge-m3 + Vectorize）が無いため、
// 文字bigramのハッシュ埋め込みとインメモリ余弦で代用する（manifestに明記する）。
import { readFileSync } from "node:fs";
import { normalize, sha256, searchTerms } from "../../../lib/knowledge/text.ts";
import { KnowledgeRepository } from "../../../lib/knowledge/repository.ts";
import { retrieve } from "../../../lib/knowledge/retrieval.ts";
import { approveImport, prepareImport, type WritableVectorIndex } from "../../../lib/knowledge/import.ts";
import { LocalDatabase } from "../../../tests/helpers.ts";
import type { EmbeddingProvider, Evidence, Turn, VectorIndex } from "../../../lib/types.ts";

export const SNAPSHOT_DOCS = ["career", "reflection", "project", "memo"];
const dataDir = new URL("../data/snapshot/", import.meta.url);

export function snapshotHash(): Promise<string> {
  const text = SNAPSHOT_DOCS.map(name => readFileSync(new URL(name + ".json", dataDir), "utf8")).join("");
  return sha256(text);
}

// 実験用の埋め込み。意味の近さは本番ほど捉えられない。
export function hashEmbedding(text: string, dimensions = 1536): number[] {
  const values = new Array<number>(dimensions).fill(0);
  for (const term of searchTerms(text)) {
    let hash = 2166136261;
    for (const char of term) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    values[(hash >>> 0) % dimensions] += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map(value => value / norm);
}

export const labEmbedding: EmbeddingProvider = {
  async embed(text: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return hashEmbedding(text);
  }
};

// インメモリの余弦索引。本番のVectorizeと同じくmetadataのfilterを尊重する。
export class LabVector implements WritableVectorIndex, VectorIndex {
  records = new Map<string, { id: string; values: number[]; metadata: Record<string, string> }>();
  offline = false;
  async upsert(vectors: { id: string; values: number[]; metadata: Record<string, string> }[]) {
    if (this.offline) return;
    for (const vector of vectors) this.records.set(vector.id, vector);
  }
  async getByIds(ids: string[]) {
    return ids.filter(id => this.records.has(id)).map(id => ({ id }));
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.records.delete(id);
  }
  async query(vector: number[], options: { topK: number; filter: Record<string, string>; returnMetadata: "none" }) {
    if (this.offline) return { matches: [] };
    const matches = [...this.records.values()]
      .filter(record => Object.entries(options.filter).every(([key, value]) => record.metadata[key] === value))
      .map(record => ({ id: record.id, score: cosine(vector, record.values) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK);
    return { matches };
  }
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * (right[index] ?? 0);
  return dot;
}

export interface Snapshot {
  db: LocalDatabase;
  vector: LabVector;
  repository: KnowledgeRepository;
  embedding: EmbeddingProvider;
  chunks: { id: string; title: string; content: string; documentId: string; revisionId: string; contentHash: string }[];
  facts: { id: string; statement: string }[];
  docKeys: Record<string, string>;
  hash: string;
}

// 架空資料を取り込み・承認する。memoは公開承認のまま取り込み、その後に非公開へ切り替える
// （取込の入口は公開だけを受け付けるため）。
export async function buildSnapshot(options: { vectorChannel?: boolean } = {}): Promise<Snapshot> {
  const db = new LocalDatabase();
  const docKeys: Record<string, string> = {};
  const facts: { id: string; statement: string }[] = [];
  const vector = new LabVector();
  vector.offline = options.vectorChannel === false;
  const embedding = labEmbedding;
  const ownerId = "fictional-minato";
  for (const name of SNAPSHOT_DOCS) {
    const bundle = JSON.parse(readFileSync(new URL(name + ".json", dataDir), "utf8")) as unknown;
    const parsed = bundle as { facts?: { id: string; statement: string }[] };
    for (const fact of parsed.facts ?? []) facts.push({ id: fact.id, statement: fact.statement });
    const prepared = await prepareImport(bundle);
    docKeys[name] = prepared.documentKey;
    await approveImport({ db, vector, embedding, prepared, approvalHash: prepared.hash, signal: new AbortController().signal });
  }
  const repository = new KnowledgeRepository(db, ownerId);
  const chunks = await currentChunks(db, ownerId);
  return { db, vector, repository, embedding, chunks, facts, docKeys, hash: await snapshotHash() };
}

// memo（価格改定の社内メモ）を非公開へ切り替える。検索と再確認から外れることを確かめる用途。
export async function hideMemo(snapshot: Snapshot): Promise<void> {
  await snapshot.db.prepare("UPDATE knowledge_document_revisions SET visibility='private' WHERE content LIKE ?")
    .bind("%価格改定%").run();
}

export async function currentChunks(db: LocalDatabase, ownerId: string) {
  const sql = "SELECT c.id AS id,c.title AS title,c.content AS content,r.document_id AS documentId,r.id AS revisionId,r.content_hash AS contentHash"
    + " FROM knowledge_chunks c JOIN knowledge_document_revisions r ON r.id=c.revision_id"
    + " JOIN knowledge_documents d ON d.active_revision_id=r.id"
    + " WHERE d.owner_id=? AND r.owner_id=? AND r.approval_status='approved' AND r.visibility='public'"
    + " ORDER BY r.document_id COLLATE BINARY, c.id COLLATE BINARY";
  const rows = await db.prepare(sql).bind(ownerId, ownerId)
    .all<{ id: string; title: string; content: string; documentId: string; revisionId: string; contentHash: string }>();
  return rows.results;
}

// ケースの根拠参照（doc + 見出し）を、いまのチャンクIDへ解決する。
export function resolveRefs(snapshot: Snapshot, refs: { doc: string; title: string }[]): { id: string; title: string }[] {
  const resolved: { id: string; title: string }[] = [];
  for (const ref of refs) {
    const chunk = snapshot.chunks.find(item => item.documentId === (snapshot.docKeys[ref.doc] ?? ref.doc)
      && normalize(item.title) === normalize(ref.title ?? ""));
    if (chunk) resolved.push({ id: chunk.id, title: chunk.title });
  }
  return resolved;
}

// B条件: 現行の初回検索。再検索はしない。
export async function retrieveForLab(input: { snapshot: Snapshot; question: string; history: Turn[] }) {
  const { snapshot } = input;
  const started = performance.now();
  const result = await retrieve({ question: input.question, history: input.history,
    repository: snapshot.repository, vector: snapshot.vector, embedding: snapshot.embedding,
    signal: new AbortController().signal });
  return { evidence: result.evidence, conflicts: result.conflicts, latencyMs: Math.round(performance.now() - started) };
}

// C条件: Bで取得した根拠だけを返すアダプター。検索・再検索で別の根拠へ動かない。
export class FrozenRepository {
  ownerId: string;
  private items: Evidence[];
  keywordCalls = 0;
  constructor(ownerId: string, items: Evidence[]) {
    this.ownerId = ownerId;
    this.items = items;
  }
  async hasKnowledge() { return true; }
  async sourceSet() { return []; }
  async keyword(_query: string) { this.keywordCalls += 1; return [...this.items]; }
  async facts() { return []; }
  async resolve(ids: string[]) { return this.items.filter(item => ids.includes(item.id)); }
  async revalidate(evidence: Evidence[]) { return evidence.every(item => this.items.some(frozen => frozen.id === item.id)); }
  async revalidateSnapshot(evidence: Evidence[]) { return this.revalidate(evidence); }
}
