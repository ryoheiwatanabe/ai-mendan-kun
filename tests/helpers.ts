import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { Database, Statement, VectorIndex } from "../lib/types.ts";
import { approveImport, prepareImport, type WritableVectorIndex } from "../lib/knowledge/import.ts";

class LocalStatement implements Statement {
  sql: string;
  connection: DatabaseSync;
  values: SQLInputValue[] = [];
  constructor(connection: DatabaseSync, sql: string) { this.connection = connection; this.sql = sql; }
  bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
  query<T>() { return { results: this.connection.prepare(this.sql).all(...this.values) as T[] }; }
  async all<T>() { return this.query<T>(); }
  async first<T>() { return (this.connection.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async run() { return this.connection.prepare(this.sql).run(...this.values); }
}
export class LocalDatabase implements Database {
  connection = new DatabaseSync(":memory:");
  constructor() {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) this.connection.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  prepare(sql: string) { return new LocalStatement(this.connection, sql); }
  async batch<T>(statements: Statement[]) {
    this.connection.exec("BEGIN");
    try {
      const results = statements.map(statement => (statement as LocalStatement).query<T>());
      this.connection.exec("COMMIT"); return results;
    } catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }
  close() { this.connection.close(); }
}

export class FakeVector implements WritableVectorIndex, VectorIndex {
  records = new Map<string, { id: string; values: number[]; metadata: Record<string, string> }>();
  failed = false;
  async upsert(vectors: { id: string; values: number[]; metadata: Record<string, string> }[]) {
    if (this.failed) throw new Error("simulated_vector_failure");
    for (const vector of vectors) this.records.set(vector.id, vector);
  }
  async getByIds(ids: string[]) { return ids.flatMap(id => this.records.has(id) ? [{ id }] : []); }
  async deleteByIds(ids: string[]) { if (this.failed) throw new Error("simulated_delete_failure"); for (const id of ids) this.records.delete(id); }
  // 故意にmetadata filterを無視。D1のGateだけでも除外できることを検証する。
  async query() { return { matches: [...this.records.keys()].map(id => ({ id, score: .9 })) }; }
}
export const embedding = { async embed(_text: string, signal?: AbortSignal) { signal?.throwIfAborted(); return [1, 0, 0]; } };
export const fixture = {
  version: 1, ownerId: "test-owner", documentId: "career", title: "架空人物の検証用プロフィール", visibility: "public", verification: "self_reported",
  entities: ["リーフ検証プロジェクト"],
  content: "# 仕事の進め方\n\n私は、早い段階で小さく試して、使う人の声を聞くことを大切にしています。\n\n# 担当と実績\n\nリーフ検証プロジェクトはチームで3件を公開しました。私は要件整理を担当し、実装は外部エンジニアが行いました。\n\n正式なPdMの肩書で勤務した経験はありません。要件整理と開発チームとの調整を担当しました。\n\n# 過去の体制\n\n2022年の検証チームは5人でした。\n\n# 現在の体制\n\n2026年の検証チームは8人です。",
  facts: [
    { id: "old-count", key: "team.size", value: "5", statement: "2022年の検証チームは5人でした。", aliases: ["チーム", "人数"], validFrom: "2022-01-01", validTo: "2022-12-31" },
    { id: "new-count", key: "team.size", value: "8", statement: "2026年の検証チームは8人です。", aliases: ["チーム", "人数"], validFrom: "2026-01-01", validTo: null }
  ]
};
export async function setup(value: unknown = fixture) {
  const db = new LocalDatabase(), vector = new FakeVector(), prepared = await prepareImport(value);
  await approveImport({ db, vector, embedding, prepared, approvalHash: prepared.hash, signal: new AbortController().signal });
  return { db, vector, prepared };
}
