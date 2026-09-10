import type { EmbeddingProvider, Evidence, Fact, Turn, VectorIndex } from "../types.ts";
import { KnowledgeRepository } from "./repository.ts";
import { normalize, searchQuery, searchTerms } from "./text.ts";

export function selectFacts(facts: Fact[], question: string, today = new Date().toISOString().slice(0, 10), timeQuestion = question) {
  const normalized = normalize(question).toLowerCase();
  const temporal = normalize(timeQuestion).toLowerCase();
  const years = [...new Set([...temporal.matchAll(/\b((?:19|20)\d{2})\s*年?/g)].map(match => match[1]))];
  const current = /現在|今は|いま|current|today/i.test(temporal);
  const date = temporal.match(/((?:19|20)\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const precise = date ? `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}` : null;
  const target = current ? { from: today, to: today } : precise ? { from: precise, to: precise }
    : years.length === 1 ? { from: `${years[0]}-01-01`, to: `${years[0]}-12-31` } : { from: today, to: today };
  if ((!current && years.length > 1) || (!current && !years.length && /当時|その頃|以前/.test(temporal)))
    return { selected: [] as Fact[], conflicts: ["target_time"] };
  const candidates = facts.filter(fact => {
    const aliases: string[] = JSON.parse(fact.aliases_json);
    return aliases.some(alias => normalized.includes(normalize(alias).toLowerCase()))
      && (!fact.valid_from || fact.valid_from <= target.to) && (!fact.valid_to || fact.valid_to >= target.from);
  });
  const byKey = new Map<string, Fact[]>();
  for (const fact of candidates) byKey.set(fact.fact_key, [...(byKey.get(fact.fact_key) ?? []), fact]);
  const selected: Fact[] = [];
  const conflicts: string[] = [];
  for (const [key, values] of byKey) {
    const superseded = new Set(values.flatMap(fact => fact.supersedes_fact_id ? [fact.supersedes_fact_id] : []));
    const current = values.filter(fact => !superseded.has(fact.id));
    if (new Set(current.map(fact => fact.fact_value)).size > 1 || (current.length === 0 && values.length)) conflicts.push(key);
    else if (current[0]) selected.push(current[0]);
  }
  return { selected, conflicts };
}

export function fuse(keyword: Evidence[], vector: Evidence[], exact: Evidence[]): Evidence[] {
  const map = new Map<string, { item: Evidence; score: number }>();
  for (const [list, weight] of [[keyword, 1], [vector, 1], [exact, 2]] as const) {
    list.forEach((item, rank) => {
      const previous = map.get(item.id);
      map.set(item.id, { item, score: (previous?.score ?? 0) + weight / (60 + rank + 1) });
    });
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 10).map(row => row.item);
}

export async function retrieve(input: {
  question: string; history: Turn[]; repository: KnowledgeRepository;
  vector: VectorIndex; embedding: EmbeddingProvider; signal: AbortSignal;
}) {
  const query = searchQuery(input.question, input.history);
  // 検索方式の失敗を無関係な原本へのfallbackで補わない。失敗は上位へ返す。
  const [keyword, allFacts, vectorResult] = await Promise.all([
    input.repository.keyword(query), input.repository.facts(),
    input.embedding.embed(query, input.signal).then(vector => input.vector.query(vector, {
      topK: 16, filter: { ownerId: input.repository.ownerId, visibility: "public" }, returnMetadata: "none"
    }))
  ]);
  input.signal.throwIfAborted();
  const selected = selectFacts(allFacts, query, undefined, /現在|今は|いま/.test(input.question) ? input.question : query);
  const vector = await input.repository.resolve(vectorResult.matches.filter(item => item.score >= 0.28).map(item => item.id));
  const exact: Evidence[] = selected.selected.map((fact, index) => ({ id: `fact:${fact.id}`, kind: "exact_fact",
    revisionId: fact.revision_id, documentId: fact.document_id, contentHash: fact.content_hash,
    title: fact.fact_key, content: fact.statement, entities: [], rank: index }));
  const normalizedQuery = normalize(query).toLowerCase();
  const relatedFacts = allFacts.filter(fact => (JSON.parse(fact.aliases_json) as string[]).some(alias => normalizedQuery.includes(normalize(alias).toLowerCase())));
  // 時点で除外した数値を同じ原文Chunkから再び採用しない。該当Factは構造化経路を正とする。
  const withoutFactChunks = (items: Evidence[]) => items.filter(item => !relatedFacts.some(fact => item.content.includes(fact.statement)));
  const fused = fuse(withoutFactChunks(keyword), withoutFactChunks(vector), exact);
  // 共通の助詞bigramだけのヒットを抑制。直接の回答可能性は生成時にも別途判断する。
  const terms = new Set(searchTerms(query));
  const evidence = fused.filter(item => item.kind === "exact_fact" || item.entities.some(entity => normalize(query).toLowerCase().includes(normalize(entity).toLowerCase()))
    || searchTerms(item.content).filter(term => terms.has(term)).length >= 2
    || vector.some(value => value.id === item.id));
  return { evidence, conflicts: selected.conflicts, query };
}
