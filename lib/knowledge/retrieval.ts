import { visibleEvidenceContent } from "./evidence-text.ts";
import type { EmbeddingProvider, Evidence, Fact, Turn, VectorIndex } from "../types.ts";
import { KnowledgeRepository } from "./repository.ts";
import { condense, normalize, searchQuery, searchTerms } from "./text.ts";

const synonymMap: [RegExp, string[]][] = [
  [/苦手|不得意|弱点|ウィークポイント/, ["課題", "苦手", "改善", "難しさ", "弱点"]],
  [/課題|改善したい|改善点/, ["課題", "苦手", "改善", "見直し", "伸びしろ"]],
  [/強み|得意|長所/, ["強み", "得意", "価値", "持ち味"]],
  [/向いて|適性|相性/, ["適性", "向き", "相性", "得意分野"]],
  [/経歴|これまでの仕事|職歴/, ["経歴", "仕事", "担当", "活動", "プロフィール"]],
  [/起業|創業/, ["起業", "創業", "設立"]],
  // 「フリーランス」「独立」は記録側の言い方（個人事業としての創業・自営など）と語が違う。
  [/フリーランス|独立|自営|個人事業|開業|雇われ/, ["フリーランス", "独立", "自営", "個人事業", "開業", "創業", "起業"]],
  // 「設立」「開始」だけの質問でも、記録側の言い方（共同創業・着手など）へ届かせる。
  [/設立|開始|始め|始まり|立ち上げ|たちあげ|発足|着手/, ["設立", "共同創業", "創業", "立ち上げ", "開始", "着手", "発足"]],
  [/売上|実績|業績/, ["売上", "実績", "業績", "成果"]],
  // 管理・育成は、記録側の言い方（SV・シフト管理・KPI運用・スタッフ育成）と語が違う。
  [/マネジメント|組織|採用|管理|リーダー|責任者|評価|育成|教育|後輩|部下|SV|スーパーバイザー/i,
    ["マネジメント", "組織", "採用", "管理", "スーパーバイザー", "SV", "シフト管理", "KPI", "育成", "教育", "後輩", "部下", "チーム"]],
  // 会社員時代の質問は、記録側の会社名や「仕事」という言い方へ届かせる。
  [/会社員|勤務|在籍|入社|退社/, ["会社員", "勤務", "入社", "退社", "仕事", "経歴"]],
  // 退職の理由は「会社員という働き方から離れた理由」として記録されている。
  [/退職理由|辞めた|辞め|やめた|退職/, ["退職", "退社", "離れ", "理由", "会社員"]],
  // 志望の理由は「応募先の選び方」「惹かれた点」として記録されている。
  [/志望動機|応募理由|なぜ応募|志望|転職を考え|選んだ理由|惹かれ/, ["志望", "理由", "応募", "応募先", "惹かれ", "転職", "選んだ"]],
  // 稼働の開始は、記録側の「週3」「稼働」「時間帯」へ届かせる。
  [/稼働|働け|働き始|就業|開始可能|いつから/, ["稼働", "開始", "週3", "時間帯", "リモート", "出社", "長期", "短期"]],
  // 課金方式の変更は、記録側の「買い切り」「訴求」「商品構成」へ届かせる。
  [/課金|料金|価格|サブスク|買い切り|収益モデル|マネタイズ/, ["課金", "買い切り", "サブスク", "料金", "価格", "訴求", "商品構成", "転換"]],
  // Web3の話題は言い方が分かれる。同じ軸の語を互いに展開して届かせる。
  [/Web3|ウェブスリー|ブロックチェーン|暗号資産|仮想通貨|Defi|DeFi|トークン|NFT|オンチェーン/, ["Web3", "ブロックチェーン", "暗号資産", "仮想通貨", "Defi", "トークン", "コミュニティ"]],
  [/価値観|大事|ポリシー/, ["価値観", "重視", "方針", "ポリシー"]]
];

export function expandQuery(question: string): string {
  // 音声認識の空白入り（例:「会 社 員」）でも同じ展開が効くように空白を詰めて調べる。
  const text = condense(question);
  const additions: string[] = [];
  for (const [pattern, words] of synonymMap) if (pattern.test(text)) additions.push(...words);
  return additions.length ? `${question}\n${[...new Set(additions)].join(" ")}` : question;
}

// 初回クエリは質問文と履歴から直接作り、類義語展開はしない。
// 展開はリトライ時（呼び出し側で retrievalQuery を渡す場合）に行うことで、
// 初回結果とリトライ結果が同一になるのを避け、リトライを意味のあるものにする。
export function retrievalQuery(question: string, history: Turn[] = []): string {
  return searchQuery(question, history).slice(0, 4000);
}

export function expandRetrievalQuery(question: string, history: Turn[] = []): string {
  return expandQuery(searchQuery(question, history)).slice(0, 4000);
}

function parseAliases(fact: Fact): string[] {
  try {
    const parsed = JSON.parse(fact.aliases_json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

// 期間（from/to）が重なるか。無期限（undefined）は常に重なるとみなす。
function periodsOverlap(
  a: { from?: string | null; to?: string | null },
  b: { from?: string | null; to?: string | null }
): boolean {
  if (a.to && b.from && a.to < b.from) return false;
  if (b.to && a.from && b.to < a.from) return false;
  return true;
}

function validOverlapsTarget(
  fact: Fact,
  target: { from?: string | null; to?: string | null }
): boolean {
  if (fact.valid_from && target.to && fact.valid_from > target.to) return false;
  if (fact.valid_to && target.from && fact.valid_to < target.from) return false;
  return true;
}

export function selectFacts(
  facts: Fact[],
  question: string,
  today = new Date().toISOString().slice(0, 10),
  timeQuestion = question
) {
  const normalized = normalize(question).toLowerCase();
  // Factの別名照合は語間の空白に左右されないようにする（音声認識は「会 社 員」のように区切る）。
  const condensed = condense(question).toLowerCase();
  // 音声認識の空白入り（「現 在」「２０２２ 年」）でも時点の語を拾えるよう空白を詰める。
  const temporal = condense(timeQuestion).toLowerCase();
  const years = [
    ...new Set(
      [...temporal.matchAll(/\b((?:19|20)\d{2})\s*年?/g)].map((match) => match[1])
    )
  ];
  const current = /現在|今は|いま|current|today/i.test(temporal);
  const date = temporal.match(/((?:19|20)\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const precise = date
    ? `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`
    : null;

  // 複数年の明示指定は「いずれかの年と期間が重なる」事実を対象にする。
  // target_time の未解決エラーは出さない。
  const explicitYears = !current && years.length > 1;
  // 「当時」「その頃」は年が無いと具体的な時点に解決できず、参照が不明なまま残るため
  // ambiguous として target_time を返す。「以前」は履歴全体の俯瞰なので全履歴を対象にする。
  const ambiguousWithoutYear =
    !current && !explicitYears && years.length === 0 && /当時|その頃/.test(temporal);
  const overview = !current && !explicitYears && years.length === 0 && !ambiguousWithoutYear;

  const interval = explicitYears
    ? { intervals: years.map((year) => ({ from: `${year}-01-01`, to: `${year}-12-31` })) }
    : overview
      ? { from: null as string | null, to: null as string | null }
      : current || !years.length || precise
        ? { from: precise ?? today, to: precise ?? today }
        : { from: `${years[0]}-01-01`, to: `${years[0]}-12-31` };

  const targetFrom = "intervals" in interval ? null : interval.from;
  const targetTo = "intervals" in interval ? null : interval.to;
  const targetIntervals = "intervals" in interval ? interval.intervals : [{ from: targetFrom, to: targetTo }];

  // 全 facts から superseded な id を集め、期間フィルタの前に除外する。
  const supersededIds = new Set<string>();
  for (const fact of facts) {
    if (fact.supersedes_fact_id) supersededIds.add(fact.supersedes_fact_id);
  }

  const candidates = facts.filter((fact) => {
    if (supersededIds.has(fact.id)) return false;
    const aliases = parseAliases(fact);
    const aliasMatch = aliases.some((alias) =>
      normalized.includes(normalize(alias).toLowerCase()) || condensed.includes(condense(alias).toLowerCase())
    );
    if (!aliasMatch) return false;
    return (targetIntervals ?? []).some((target) => validOverlapsTarget(fact, target));
  });

  const byKey = new Map<string, Fact[]>();
  for (const fact of candidates) {
    byKey.set(fact.fact_key, [...(byKey.get(fact.fact_key) ?? []), fact]);
  }

  const selected: Fact[] = [];
  const conflicts: string[] = [];
  for (const [key, values] of byKey) {
    // 同一キー・同一値・異なる期間は異なる事実として保持する。
    // 同一キー・異なる値の場合は期間が重なる時だけ矛盾とする。
    const byValue = new Map<string, Fact[]>();
    for (const fact of values) {
      byValue.set(fact.fact_value, [...(byValue.get(fact.fact_value) ?? []), fact]);
    }
    if (byValue.size > 1) {
      const valueGroups = [...byValue.values()];
      let clashing = false;
      for (let i = 0; i < valueGroups.length && !clashing; i++) {
        for (let j = i + 1; j < valueGroups.length && !clashing; j++) {
          for (const left of valueGroups[i]) {
            for (const right of valueGroups[j]) {
              if (
                periodsOverlap(
                  { from: left.valid_from, to: left.valid_to },
                  { from: right.valid_from, to: right.valid_to }
                )
              ) {
                clashing = true;
                break;
              }
            }
            if (clashing) break;
          }
        }
      }
      if (clashing) conflicts.push(key);
    }
    // 期間が重ならない別値、または同一値の複数期間はすべて選択する。
    // （上限10は後段の fuse で適用される。）
    selected.push(...values);
  }

  selected.sort((a, b) => (a.valid_from ?? "").localeCompare(b.valid_from ?? ""));

  if (ambiguousWithoutYear) conflicts.push("target_time");

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
  const ranked = [...map.values()]
    .sort((a, b) => b.score - a.score)
    // 類義語の揺れ（設立と共同創業など）で順位が下がる候補も、回答モデルへ渡す範囲に残す。
    .map((row) => row.item);
  // 融合の順位だけで切ると、片方の検索にしか出なかった上位候補が落ちる。
  // 例: 質問の語を見出しに持つ段落が、キーワード4位・ベクトル13位で9位相当になり、上位8件から漏れる。
  // 各検索の上位3件と事実は、順位が下でも残す（上限は変えない）。
  const essential = new Set([...exact, ...keyword.slice(0, 3), ...vector.slice(0, 3)].map((item) => item.id));
  const picked = ranked.slice(0, 10);
  const kept = new Set(picked.map((item) => item.id));
  for (const item of ranked) {
    if (!essential.has(item.id) || kept.has(item.id)) continue;
    // 優先候補でない末尾を入れ替える。優先候補どうしは追い出さない。
    let index = -1;
    for (let cursor = picked.length - 1; cursor >= 0; cursor--) {
      if (!essential.has(picked[cursor].id)) { index = cursor; break; }
    }
    if (index < 0) break;
    kept.delete(picked[index].id);
    picked[index] = item;
    kept.add(item.id);
  }
  return picked;
}

export async function retrieve(input: {
  question: string;
  history: Turn[];
  repository: KnowledgeRepository;
  vector: VectorIndex;
  embedding: EmbeddingProvider;
  signal: AbortSignal;
  retrievalQuery?: string;
}) {
  // 初回は expandQuery を使わない。expand されたクエリはリトライ時に
  // input.retrievalQuery として呼び出し側から渡す。
  const query = input.retrievalQuery ?? retrievalQuery(input.question, input.history);
  const [keyword, allFacts, vectorResult] = await Promise.all([
    input.repository.keyword(query),
    input.repository.facts(),
    input.embedding.embed(query, input.signal).then((vector) =>
      input.vector.query(vector, {
        topK: 16,
        filter: { ownerId: input.repository.ownerId, visibility: "public" },
        returnMetadata: "none"
      })
    )
  ]);
  input.signal.throwIfAborted();
  const userTurns = input.history.filter((turn) => turn.role === "user");
  const timeQuery = /現在|今は|いま/.test(condense(input.question))
    ? input.question
    : searchQuery(input.question, userTurns.slice(-2));
  const selected = selectFacts(allFacts, query, undefined, timeQuery);
  const vector = await input.repository.resolve(
    vectorResult.matches.filter((item) => item.score >= 0.28).map((item) => item.id)
  );
  input.signal.throwIfAborted();

  const exact: Evidence[] = selected.selected.map((fact, index) => ({
    id: `fact:${fact.id}`,
    kind: "exact_fact",
    revisionId: fact.revision_id,
    documentId: fact.document_id,
    contentHash: fact.content_hash,
    title: fact.fact_key,
    content: fact.statement,
    entities: [],
    rank: index
  }));

  const normalizedQuery = normalize(query).toLowerCase();
  const matchedFacts = allFacts.filter((fact) =>
    parseAliases(fact).some((alias) => normalizedQuery.includes(normalize(alias).toLowerCase()))
  );
  // 原本は再照合用に保持し、関連Factの段落だけを生成・校閲・引用検証から隠す。
  // 同じチャンクの独立した段落は残し、数値は時点を選択したexact_fact経路から渡す。
  const withoutFactChunks = (items: Evidence[]) => items.map(item => ({ ...item,
    excludedStatements: matchedFacts.filter(fact => item.content.includes(fact.statement)).map(fact => fact.statement)
  })).filter(item => visibleEvidenceContent(item).trim());

  const fused = fuse(withoutFactChunks(keyword), withoutFactChunks(vector), exact);
  // 同じ話題の別資料（例: 事業の説明と、その事業の実績数値）を組み合わせて答えられるよう、
  // 見つかった根拠の見出しでもう一度だけ検索し、同じ話題の資料を候補へ足す。
  // 足すのは候補の上限に空きがある場合だけで、見つかった根拠は押しのけない。
  const relatedQuery = [...new Set(fused.slice(0, 3).map((item) => item.title).filter(Boolean))].join("\n");
  const related = relatedQuery ? await input.repository.keyword(relatedQuery) : [];
  const terms = new Set(searchTerms(query));
  const evidence = fused.filter(
    (item) =>
      item.kind === "exact_fact" ||
      item.entities.some((entity) =>
        normalize(query).toLowerCase().includes(normalize(entity).toLowerCase())
      ) ||
      searchTerms(`${item.title}\n${item.content}`).filter((term) => terms.has(term)).length >= 2 ||
      vector.some((value) => value.id === item.id)
  );
  const scores = new Map(
    vectorResult.matches
      .filter((item) => Number.isFinite(item.score) && item.score >= 0 && item.score <= 1)
      .map((item) => [item.id, item.score])
  );
  const similarityScores = new Map(
    evidence.flatMap((item) =>
      item.kind === "chunk" && scores.has(item.id) ? ([[item.id, scores.get(item.id)!]] as const) : []
    )
  );
  // 同じ話題の資料は、候補の上限に空きがあれば足す。再照合の上限は10件。
  const extra = withoutFactChunks(related)
    .filter((item) => !evidence.some((current) => current.id === item.id))
    .slice(0, Math.max(0, 10 - evidence.length));
  // 取得候補（絞り込む前の和集合）と採用候補の件数を、本文を含めずに返す。
  const retrieved = new Set([...keyword, ...vector, ...exact].map((item) => item.id)).size;
  return { evidence: [...evidence, ...extra], conflicts: selected.conflicts, query, similarityScores, retrieved };
}
