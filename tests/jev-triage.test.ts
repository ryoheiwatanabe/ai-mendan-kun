// 生成前の選別（triage）と、生成・却下の経路を、テキストと音声で共通の入口
// verifiedCompactAnswer から確認する。提供元APIは呼ばず、判定器・生成器・リポジトリを固定のモックにして、
// 「どの段階をどの順で呼び、どの根拠を生成へ渡したか」だけを検証する。
// ここで確かめられるのは経路と根拠の受け渡しであり、モデルの正確さは対象外。
import test from "node:test";
import assert from "node:assert/strict";
import { JevPipelineError, verifiedCompactAnswer } from "../lib/answer/jev-pipeline.ts";
import { defaultJevSettings, type JevSettings } from "../lib/answer/jev-settings.ts";
import { lengthPolicy } from "../lib/answer/length-policy.ts";
import { jevQuestionIds, type JevInput, type JevJudge, type JevScopeAssessment, type JevScopeInput,
  type JevScores } from "../lib/ai/jev.ts";
import { jevScopeAnswerScopeId, jevScopeEvidenceRoleId, jevScopeNoPrimary, jevScopeNoulIds,
  jevScopePrimaryEvidenceId, jevScopeSupportStrengthId, type JevScopeNoulAxis } from "../lib/ai/jev-scope.ts";
import type { JevRoutesAssessment, JevRoutesInput } from "../lib/ai/jev-routes.ts";
import type { ParsedAnswer } from "../lib/ai/jev-primitives.ts";
import type { AnswerProvider, Diagnostic, Evidence, Turn } from "../lib/types.ts";
import type { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import type { CompactCandidate, CompactInput } from "../lib/answer/compact.ts";

const question = "仕事の進め方を教えてください";
const rawAnswer = "早い段階で小さく試し、使う人の声を聞くことを大切にしています。";

// 実在の人物・会社は使わない。検証に要る形（見出し・本文・Fact・順位）だけを固定する。
function evidenceOf(id: string, options: { documentId?: string; kind?: Evidence["kind"]; rank?: number;
  title?: string; content?: string } = {}): Evidence {
  return { id, revisionId: id.split(":")[0], documentId: options.documentId ?? id.split(":")[0],
    title: options.title ?? "仕事の進め方", content: options.content ?? "早い段階で小さく試し、使う人の声を聞くことを大切にしています。",
    contentHash: `hash-${id}`, entities: [], kind: options.kind ?? "chunk", rank: options.rank ?? 1 };
}

const pair = [evidenceOf("rev_a:0", { documentId: "career", rank: 1 }),
  evidenceOf("rev_b:1", { documentId: "values", rank: 2 })];

// 10件の既存根拠。事実と、担当・条件を示す文を必ず含める。
const tenOld = [
  evidenceOf("rev_a:0", { documentId: "career", rank: 1, content: "2016年から2019年までナギサ社で営業を担当しました。" }),
  evidenceOf("rev_b:1", { documentId: "values", rank: 2 }),
  evidenceOf("rev_c:2", { documentId: "practice", rank: 3, content: "課題を小さく分けて整理することを大切にしています。" }),
  evidenceOf("rev_d:3", { documentId: "learning", rank: 4, content: "家にあった辞書を毎日読んだことが読書の始まりです。" }),
  evidenceOf("rev_e:4", { documentId: "team", rank: 5, content: "2022年の検証チームは5人でした。" }),
  evidenceOf("rev_f:5", { documentId: "team2026", rank: 6, content: "2026年の検証チームは8人でした。" }),
  evidenceOf("rev_g:6", { documentId: "role", rank: 7, content: "要件整理と開発チームとの調整を担当しました。" }),
  evidenceOf("rev_h:7", { documentId: "review", rank: 8, content: "公開前に、本人が読み直して表現を直しました。" }),
  evidenceOf("fact:career", { documentId: "career", kind: "exact_fact", rank: 9,
    content: "2024年に独立し、個人事業として小規模事業者の業務整理を支援しています。" }),
  evidenceOf("rev_i:9", { documentId: "practice2", rank: 10,
    content: "ホタル企画では、問い合わせ対応を三つの作業に分けました。実装は外部エンジニアが担当し、本人は要件整理を担当しました。" })
];
const qualifier = "実装は外部エンジニアが担当し、本人は要件整理を担当しました。";

type ScopeReply = { answerScope?: string; role?: string; primary?: string | null; support?: number; confidence?: number;
  noul?: Partial<Record<JevScopeNoulAxis, number>> };

// 選別（Choice/Score/Noul）の応答を、型どおりに組み立てる。
function scopeAssessment(reply: ScopeReply, candidateIds: readonly string[]): JevScopeAssessment {
  const confidence = reply.confidence ?? .95;
  const noul: Record<JevScopeNoulAxis, number> = { target_match: .95, time_match: .95, direct_support: .95,
    background_support: .95, causal_support: .95, conflict_risk: .05, ...reply.noul };
  const primary = reply.primary === undefined ? candidateIds[0] ?? jevScopeNoPrimary : reply.primary ?? jevScopeNoPrimary;
  const answers: Record<string, ParsedAnswer> = {
    [jevScopeAnswerScopeId]: { type: "choice", choice: reply.answerScope ?? "answerable", confidence },
    [jevScopeEvidenceRoleId]: { type: "choice", choice: reply.role ?? "direct", confidence },
    [jevScopePrimaryEvidenceId]: { type: "choice", choice: primary, confidence },
    [jevScopeSupportStrengthId]: { type: "score", score: Math.round((reply.support ?? .8) * 3), levels: 4, confidence },
    ...Object.fromEntries(jevScopeNoulIds.map(axis => [axis, { type: "noul" as const, value: noul[axis] }]))
  };
  return { answers, asked: Object.keys(answers), criteria: {} };
}

const allPass = (): Partial<JevScores> => Object.fromEntries(jevQuestionIds.map(axis => [axis, .97])) as Partial<JevScores>;

type CaseConfig = {
  question?: string;
  evidence: Evidence[];
  settings?: (settings: JevSettings) => void;
  scope?: (call: number, input: JevScopeInput) => ScopeReply;
  scores?: (call: number, input: JevInput) => Partial<JevScores>;
  candidate?: (call: number, input: CompactInput) => unknown;
  search?: (query: string, signal: AbortSignal) => Promise<Evidence[]>;
  revalidate?: (call: number, evidence: Evidence[]) => boolean;
  // 音声の再照合へ知らせる最終の根拠集合（テキストと音声で同じ経路）。
  onEvidence?: (evidence: Evidence[]) => void;
  // 直前の会話。指示語の解決に使う。
  history?: Turn[];
};

type Counters = { order: string[]; scopeCalls: JevScopeInput[]; routeCalls: JevRoutesInput[]; judgeCalls: JevInput[];
  generations: CompactInput[]; searches: string[]; revalidated: Evidence[][]; diagnostics: Diagnostic[] };
type CaseResult = Counters & { candidate?: CompactCandidate; error?: unknown };

// 段階・探索・判定・生成を固定のモックにし、呼ばれた順と入力をそのまま残す。
function build(config: CaseConfig) {
  const settings = defaultJevSettings();
  config.settings?.(settings);
  const counters: Counters = { order: [], scopeCalls: [], routeCalls: [], judgeCalls: [], generations: [],
    searches: [], revalidated: [], diagnostics: [] };
  const provider: AnswerProvider = {
    async *stream() { throw new Error("legacy_stream_must_not_run"); },
    async generateCompact(input) {
      counters.order.push("generate");
      counters.generations.push(input);
      const call = counters.generations.length;
      return { candidate: config.candidate ? config.candidate(call, input)
        : { text: rawAnswer, answerability: "answerable", evidenceIds: input.evidence.map(item => item.id) } };
    }
  };
  const judge: JevJudge = {
    async check(input) { counters.order.push("judge"); counters.judgeCalls.push(input);
      return { scores: config.scores ? config.scores(counters.judgeCalls.length, input) : allPass() }; },
    async checkScope(input) {
      counters.order.push("scope"); counters.scopeCalls.push(input);
      if (!config.scope) throw new Error("scope_not_stubbed");
      return scopeAssessment(config.scope(counters.scopeCalls.length, input), input.evidence.map(item => item.id));
    },
    // 探索を始めた場合だけ呼ばれる。既定は「どのルートも答えに足りない」応答にする。
    async checkRoutes(input) {
      counters.order.push("routes"); counters.routeCalls.push(input);
      return { scores: Object.fromEntries(input.routes.map(route => [route.id, { support: .3, target: .3 }])) } as JevRoutesAssessment;
    }
  };
  const repository = {
    async revalidateSnapshot(evidence: Evidence[]) {
      counters.order.push("revalidate"); counters.revalidated.push([...evidence]);
      return config.revalidate ? config.revalidate(counters.revalidated.length, evidence) : true;
    }
  } as unknown as KnowledgeRepository;
  const deps: Parameters<typeof verifiedCompactAnswer>[1] = {
    provider, repository, jev: { judge, timeoutMs: 25_000, settings },
    deadline: performance.now() + 60_000,
    ...(config.onEvidence ? { onEvidence: config.onEvidence } : {}),
    ...(config.search ? { search: async (query: string) => { counters.order.push("search"); counters.searches.push(query);
      return config.search!(query, new AbortController().signal); } } : {}),
    diagnostics: (diagnostic: Diagnostic) => counters.diagnostics.push(diagnostic)
  };
  return { counters, deps, settings };
}

async function runCase(config: CaseConfig): Promise<CaseResult> {
  const { counters, deps } = build(config);
  const asked = config.question ?? question;
  const input: CompactInput = { question: asked, history: config.history ?? [], evidence: config.evidence,
    lengthBudget: lengthPolicy(asked) };
  try {
    const candidate = await verifiedCompactAnswer(input, deps, new AbortController().signal);
    return { ...counters, candidate };
  } catch (error) {
    return { ...counters, error };
  }
}

const stagesUsed = (result: CaseResult) => result.diagnostics.filter(item => item.code === "stages_used").at(-1)?.count ?? 0;
const idsOf = (input: { evidence: Evidence[] }) => input.evidence.map(item => item.id);

test("確認できる直接の根拠では、選別を先に行い、ビーム探索も追加検索も始めない", async () => {
  const result = await runCase({ evidence: pair, search: async () => [evidenceOf("extra:1", { documentId: "extra" })],
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: () => ({ answerScope: "answerable", role: "direct", confidence: .95 }) });
  assert.equal(result.error, undefined, "確認できた直接の根拠はそのまま回答する");
  assert.ok(result.order.includes("scope"), "選別は行う");
  assert.ok(!result.order.includes("routes"), "探索は行わない");
  assert.ok(result.order.indexOf("scope") < result.order.indexOf("generate"), "選別の後に生成する");
  assert.equal(result.routeCalls.length, 0, "直接の根拠が確認できたらビーム探索を始めない");
  assert.equal(result.searches.length, 0, "追加検索も始めない");
  assert.equal(result.scopeCalls.length, 1, "選別は1回で足りる");
  assert.equal(result.generations.length, 1, "生成は1回");
  assert.equal(result.judgeCalls.length, 1, "最終点検は1回");
  assert.equal(result.candidate?.text, rawAnswer, "生の候補をそのまま返す");
  assert.ok(stagesUsed(result) <= 8, "段数を使い切らない");
  assert.ok(result.diagnostics.some(item => item.code === "beam_skipped"), "探索を始めなかった理由を残す");
});

test("部分・不足では経路を探索し、新しい根拠が増えたときだけ選別をやり直す", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 3 }),
    evidenceOf("extra:2", { documentId: "extra2", rank: 4 })];
  const result = await runCase({ evidence: pair, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: call => call === 1 ? { answerScope: "partial", role: "mixed", primary: null }
      : { answerScope: "answerable", role: "direct", primary: "rev_a:0" } });
  assert.equal(result.error, undefined, "探索のあとの直接回答はそのまま返す");
  assert.ok(result.routeCalls.length >= 1, "部分・不足では経路を探索する");
  assert.ok(result.order.indexOf("scope") < result.order.indexOf("routes"), "選別を探索より先に始める");
  assert.equal(result.scopeCalls.length, 2, "新しい根拠が増えたら選別をやり直す");
  const second = idsOf(result.scopeCalls[1]);
  for (const extra of extras) assert.ok(second.includes(extra.id), `やり直しの選別へ ${extra.id} を渡す`);
  assert.equal(result.generations.length, 1, "生成は1回のまま");
  const sent = idsOf(result.generations[0]);
  for (const extra of extras) assert.ok(sent.includes(extra.id), `生成へ ${extra.id} を渡す`);
  assert.equal(result.judgeCalls.length, 1);
  assert.ok(result.judgeCalls[0].evidence.some(item => item.id === "extra:1"), "最終点検にも同じ根拠を渡す");
});

test("新しい根拠が増えなかったときは、選別をやり直さない", async () => {
  const result = await runCase({ evidence: pair, search: async () => [],
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: () => ({ answerScope: "partial", role: "mixed", primary: null }) });
  assert.ok(result.routeCalls.length >= 1, "探索自体は行う");
  assert.ok(result.diagnostics.some(item => item.code === "beam_attempt"), "探索を試したことを残す");
  assert.equal(result.scopeCalls.length, 1, "増えた根拠が無ければ選別はやり直さない");
  assert.equal(result.generations.length, 1);
});

test("既存10件と追加2件の直接回答は、原文のまま最終点検まで届き、元の事実と条件を残す", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 11 }),
    evidenceOf("extra:2", { documentId: "extra2", rank: 12 })];
  const result = await runCase({ evidence: tenOld, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: call => call === 1 ? { answerScope: "partial", role: "mixed", primary: null }
      : { answerScope: "answerable", role: "direct", primary: "fact:career" },
    // 引用できる根拠IDは最大10件。必要な分だけを挙げる。
    candidate: () => ({ text: rawAnswer, answerability: "answerable", evidenceIds: ["fact:career", "extra:1"] }) });
  assert.equal(result.error, undefined);
  assert.equal(result.scopeCalls.length, 2, "追加のあとに最終の選別を行う");
  assert.ok(stagesUsed(result) <= 8, "段数の上限を超えない");
  assert.equal(result.generations.length, 1);
  assert.equal(result.judgeCalls.length, 1);
  assert.equal(result.candidate?.text, rawAnswer, "生成した本文を変えずに返す");
  const generation = result.generations[0];
  const sent = idsOf(generation);
  assert.equal(sent.length, 12, "古い10件と新しい2件をまとめて渡す");
  for (const item of tenOld) assert.ok(sent.includes(item.id), `${item.id} を落とさない`);
  for (const extra of extras) assert.ok(sent.includes(extra.id), `${extra.id} を落とさない`);
  assert.equal(generation.evidence.find(item => item.id === "fact:career")?.kind, "exact_fact", "Factの種別を保つ");
  assert.ok(generation.evidence.some(item => item.id === "rev_i:9" && item.content.includes(qualifier)), "担当・条件の文をそのまま残す");
  assert.equal(generation.plan?.primaryEvidenceId, "fact:career", "元のFactを主な根拠として渡す");
});

test("背景だけの部分回答は1回だけ生成し、資料に無い因果を持ち込まない", async () => {
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "partial", role: "background", primary: "rev_a:0", support: .5,
      noul: { direct_support: .2, causal_support: .2 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 1, "部分でも生成は1回");
  const generation = result.generations[0];
  assert.equal(generation.plan?.backgroundOnly, true, "背景として扱う指示を渡す");
  assert.equal(generation.plan?.causalityUnconfirmed, true, "因果を断定させない");
  assert.ok((generation.plan?.directive ?? "").includes("背景"), "背景の指示を生成へ渡す");
  assert.ok(!/(だから|そのため|おかげで|理由で)/.test(result.candidate?.text ?? ""), "資料に無い因果の言い回しを足さない");
  assert.equal(result.judgeCalls.length, 1);
  assert.ok((result.judgeCalls[0].answerScope ?? "").length > 0, "選別が決めた範囲を最終点検にも渡す");
});

test("対象が決まらない確信のある曖昧は、生成せずに定型で確認を促す", async () => {
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "ambiguous", role: "mixed", primary: null, confidence: .95,
      noul: { direct_support: .2, background_support: .2 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 0, "曖昧では生成を始めない");
  assert.equal(result.judgeCalls.length, 0, "固定の案内は判定へ二重にかけない");
  assert.ok(!result.diagnostics.some(item => item.code === "generation_attempt"), "生成の段を始めていない");
  const text = result.candidate?.text ?? "";
  assert.ok(/(教えて|確認|どの)/.test(text), "対象や条件を確かめる定型を返す");
  assert.ok(!/(ナギサ|アオイ|ホタル)/.test(text), "無関係な人物や会社を答えに混ぜない");
  assert.notEqual(result.candidate?.answerability, "answerable");
});

test("答えが無く無関係と判定されたときは、探索のあとに定型の不足案内を返す", async () => {
  const result = await runCase({ evidence: pair, search: async () => [],
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: () => ({ answerScope: "insufficient", role: "irrelevant", primary: null,
      noul: { direct_support: .1, background_support: .1 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 0, "不足でも生成を始めない");
  assert.equal(result.judgeCalls.length, 0, "固定の案内は判定へ二重にかけない");
  assert.match(result.candidate?.text ?? "", /確認できません|確認できていません|面談/);
  assert.equal(result.candidate?.answerability, "unknown");
});

test("定型の確認候補は、前段の判断だけで返し、作り直さない", async () => {
  // 案内の本文は固定で、事実も推測も述べない。同じ判定をもう一度かけると、案内自体が棄権として落ちる。
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "ambiguous", role: "mixed", primary: null }) });
  assert.equal(result.error, undefined, "案内を本文なしの失敗にしない");
  assert.equal(result.generations.length, 0, "修復のための生成も始めない");
  assert.equal(result.judgeCalls.length, 0, "固定の案内を判定へかけない");
  assert.equal(result.candidate?.answerability, "unknown");
  assert.ok(result.diagnostics.some(item => item.code === "answer_accepted" && item.reason === "clarify"));
});

test("捏造した因果や広げた断定は、保存済みの設定の下で変わらず却下する", async () => {
  for (const axis of ["no_invented_causality", "no_scope_expansion"] as const) {
    const result = await runCase({ evidence: pair,
      scope: () => ({ answerScope: "answerable", role: "direct" }),
      candidate: (_call, input) => ({ text: "資料に無い理由を断定した回答です。", answerability: "answerable",
        evidenceIds: input.evidence.map(item => item.id) }),
      scores: () => ({ [axis]: .1 }) });
    assert.ok(result.error instanceof JevPipelineError, `${axis}: 却下する`);
    assert.equal((result.error as JevPipelineError).code, "ANSWER_REJECTED");
    assert.equal(result.generations.length, 2, `${axis}: 修復は1回だけ試す`);
    assert.ok(result.judgeCalls.length >= 2, `${axis}: 修復した候補も点検する`);
    assert.ok(result.generations[1].repair, `${axis}: 直す点を伝えて作り直す`);
    assert.ok(result.diagnostics.some(item => item.code === "jev_rejected" && item.reason === axis));
    assert.equal(result.candidate, undefined, `${axis}: 未検証の本文は返さない`);
  }
});

test("段数の上限が足りないときは、選別のやり直しをせずに段数を使い切らない", async () => {
  const result = await runCase({ evidence: pair, search: async () => [evidenceOf("extra:1", { documentId: "extra" })],
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 4; },
    scope: () => ({ answerScope: "partial", role: "mixed", primary: null }) });
  assert.ok(stagesUsed(result) <= 4, "段数の上限を超えない");
  assert.ok(result.scopeCalls.length <= 1, "最終生成と修復の段を残せないときは選別をやり直さない");
  if (result.error) assert.ok(result.error instanceof JevPipelineError, "中断はパイプラインのコードで返す");
});

test("探索で足した根拠も、生成直前の失効確認に含める", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 11 })];
  const result = await runCase({ evidence: tenOld, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: () => ({ answerScope: "partial", role: "mixed", primary: null }),
    candidate: (_call, input) => ({ text: rawAnswer, answerability: "answerable",
      evidenceIds: ["fact:career", "extra:1"].filter(id => input.evidence.some(item => item.id === id)) }),
    // 追加した根拠を含む集合だけを失効させる（外へ送る前の照合で止まる）。
    revalidate: (_call, evidence) => !evidence.some(item => item.id === "extra:1") });
  assert.ok(result.revalidated.some(items => items.some(item => item.id === "extra:1")), "探索で足した根拠も照合へ含める");
  assert.equal(result.generations.length, 0, "失効を確認したら生成を始めない");
  assert.ok(result.error instanceof JevPipelineError);
  assert.equal((result.error as JevPipelineError).code, "ANSWER_PROCESSING_FAILED");
  assert.equal(result.candidate, undefined, "失効した根拠から作った本文は返さない");
});

// 通常の設定（段数5・修復1・探索3巡）で、最後に評価したラウンドの探索結果が生成と選び直しへ届くこと。
// 設定を8へ上げないと直らない実装は、この確認で落ちる。
test("通常の段数5でも、最後のラウンドで見つけた根拠が生成と選び直しに届く", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 11 })];
  const result = await runCase({ evidence: tenOld, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 5;
      settings.limits.maxRepairs = 1; settings.beam.maxRounds = 3; },
    scope: call => call === 1 ? { answerScope: "partial", role: "mixed", primary: null }
      : { answerScope: "answerable", role: "direct", primary: "fact:career" },
    candidate: (_call, input) => ({ text: rawAnswer, answerability: "answerable",
      evidenceIds: ["fact:career", "extra:1"].filter(id => input.evidence.some(item => item.id === id)) }) });
  assert.equal(result.error, undefined, "段数5の通常設定で回答まで進む");
  assert.ok(stagesUsed(result) <= 5, "段数の上限を超えない");
  assert.ok(result.searches.length >= 1, "最後のラウンドでも探索を行う");
  assert.equal(result.scopeCalls.length, 2, "追加のあとに選別をやり直す");
  assert.equal(result.generations.length, 1, "生成は1回");
  assert.equal(result.candidate?.text, rawAnswer);
  const sent = idsOf(result.generations[0]);
  assert.ok(sent.includes("extra:1"), "探索で見つけた根拠を生成へ渡す");
  for (const item of tenOld) assert.ok(sent.includes(item.id), `${item.id} を落とさない`);
});

// やり直した選別が低確信になったときも、管理者が選んだ「保留」をそのまま効かせる。
// 生成を始めず、未検証の本文も返さない。
test("やり直した選別が低確信で保留の設定なら、生成せずに保留を返す", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 3 })];
  const result = await runCase({ evidence: pair, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8;
      settings.scope.confidenceThreshold = .5; settings.scope.lowConfidenceAction = "hold"; },
    scope: call => call === 1
      ? { answerScope: "partial", role: "mixed", primary: null, confidence: .95 }
      : { answerScope: "answerable", role: "direct", primary: "extra:1", confidence: .1 } });
  assert.equal(result.scopeCalls.length, 2, "やり直した選別で低確信になる");
  assert.ok(result.error instanceof JevPipelineError);
  assert.equal((result.error as JevPipelineError).code, "ANSWER_HELD");
  assert.equal(result.generations.length, 0, "保留では生成を始めない");
  assert.equal(result.judgeCalls.length, 0, "保留では最終点検も行わない");
  assert.equal(result.candidate, undefined, "未検証の本文は返さない");
});

test("最終点検と音声への通知には、生成へ渡したのと同じ根拠と設計を使う", async () => {
  const extras = [evidenceOf("extra:1", { documentId: "extra", rank: 3 })];
  const notified: Evidence[][] = [];
  const result = await runCase({ evidence: pair, search: async () => extras,
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: call => call === 1 ? { answerScope: "partial", role: "mixed", primary: null }
      : { answerScope: "answerable", role: "direct", primary: "extra:1" },
    onEvidence: items => notified.push(items) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 1, "生成は1回");
  const generated = idsOf(result.generations[0]);
  assert.deepEqual(idsOf(result.judgeCalls[0]), generated, "最終点検へ同じ根拠集合を渡す");
  assert.equal(notified.length, 1, "音声への通知は1回だけ");
  assert.deepEqual(notified[0].map(item => item.id), generated, "音声の再照合へ同じ集合を知らせる");
  assert.deepEqual(result.judgeCalls[0].answerPlan, result.generations[0].plan, "点検へ同じ設計を渡す");
  assert.equal(result.generations[0].plan?.primaryEvidenceId, "extra:1", "選び直した主根拠を設計に残す");
});

test("長さだけの削りが担当条件を落としたときは、そのまま返さず作り直す", async () => {
  const tooLong = "結論です。" + "あ".repeat(230) + "。担当条件は本人が要件整理を担当し、実装は外部エンジニアが担当しました。";
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "answerable", role: "direct" }),
    candidate: (_call, input) => ({ text: tooLong, answerability: "answerable", evidenceIds: input.evidence.map(item => item.id) }),
    scores: () => ({ claims_supported: .1 }) });
  assert.equal(result.generations.length, 2, "削った本文が落ちたら作り直す");
  assert.equal(result.judgeCalls.length, 2);
  assert.equal(result.judgeCalls[0].candidate, "結論です。", "削った本文も最終点検へ通す");
  assert.ok(!result.judgeCalls[0].candidate.includes("外部エンジニア"), "落ちた条件を未確認のまま通さない");
  assert.ok(result.diagnostics.some(item => item.code === "length_trimmed" && item.reason === "first_attempt"));
  assert.ok(result.error instanceof JevPipelineError);
  assert.equal((result.error as JevPipelineError).code, "ANSWER_REJECTED");
  assert.equal(result.candidate, undefined, "条件を落とした本文は返さない");
});

test("名前を尋ねられたときの定型は、名前の確認文で文字数にも収める", async () => {
  const result = await runCase({ question: "お名前は何ですか？", evidence: pair,
    scope: () => ({ answerScope: "ambiguous", role: "mixed", primary: null,
      noul: { direct_support: .2, background_support: .2 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 0, "生成を始めない");
  assert.equal(result.candidate?.text, "どの対象の名前を知りたいか教えてください。");
  assert.equal(result.candidate?.answerability, "unknown");
  assert.equal(result.candidate?.evidenceIds.length, 0, "事実の根拠を付けない");
  assert.ok(!result.diagnostics.some(item => item.code === "candidate_rejected"), "機械確認で落とさない");
  assert.equal(result.judgeCalls.length, 0, "固定の案内は判定へ二重にかけない");
});

// 4つの安定したシナリオ家系の分母件数を、1つの表にまとめて残す。
type Family = "direct" | "background_partial" | "ambiguous" | "insufficient";
const families: Family[] = ["direct", "background_partial", "ambiguous", "insufficient"];
const metrics: Record<Family, { questions: number; scopePasses: number; generations: number; finalChecks: number; accepted: number }> =
  Object.fromEntries(families.map(family => [family, { questions: 0, scopePasses: 0, generations: 0, finalChecks: 0, accepted: 0 }])) as
    Record<Family, { questions: number; scopePasses: number; generations: number; finalChecks: number; accepted: number }>;

function familyConfig(family: Family): CaseConfig {
  if (family === "direct") return { evidence: pair, scope: () => ({ answerScope: "answerable", role: "direct" }) };
  if (family === "background_partial") return { evidence: pair,
    scope: () => ({ answerScope: "partial", role: "background", primary: "rev_a:0", support: .5,
      noul: { direct_support: .2, causal_support: .2 } }) };
  if (family === "ambiguous") return { evidence: pair,
    scope: () => ({ answerScope: "ambiguous", role: "mixed", primary: null }) };
  return { evidence: pair, scope: () => ({ answerScope: "insufficient", role: "irrelevant", primary: null,
    noul: { direct_support: .1, background_support: .1 } }) };
}

test("四つのシナリオ家系ごとに、質問数を分母にした件数をまとめて残す", async () => {
  const rows = {} as Record<Family, { questions: number; accepted: number; generations: number; scopePasses: number; finalChecks: number }>;
  for (const family of families) {
    const result = await runCase(familyConfig(family));
    const row = metrics[family];
    row.questions += 1;
    row.scopePasses += result.scopeCalls.length;
    row.generations += result.generations.length;
    row.finalChecks += result.judgeCalls.length;
    row.accepted += result.error ? 0 : 1;
    rows[family] = { questions: 1, accepted: result.error ? 0 : 1, scopePasses: result.scopeCalls.length,
      generations: result.generations.length, finalChecks: result.judgeCalls.length };
  }
  // 分母（質問数）と、家系ごとの期待値を1つの表で固定する。
  assert.deepEqual(rows, {
    direct: { questions: 1, accepted: 1, scopePasses: 1, generations: 1, finalChecks: 1 },
    background_partial: { questions: 1, accepted: 1, scopePasses: 1, generations: 1, finalChecks: 1 },
    ambiguous: { questions: 1, accepted: 1, scopePasses: 1, generations: 0, finalChecks: 0 },
    insufficient: { questions: 1, accepted: 1, scopePasses: 1, generations: 0, finalChecks: 0 }
  });
  for (const family of families) assert.ok(metrics[family].questions >= 1, `${family} の質問数（分母）を残す`);
  assert.equal(families.reduce((sum, family) => sum + metrics[family].questions, 0) >= families.length, true);
});

test("対象が合わないという判定では、作り直さずに資料に無いことの案内を返す", async () => {
  // 応募先の情報が資料に無い質問のように、対象一致だけが届かない場合。同じ材料での全文再生成を重ねない。
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "answerable", role: "direct" }),
    scores: call => call === 1 ? { target_match: .1 } : allPass() });
  assert.equal(result.error, undefined, "本文なしの却下で終えない");
  assert.equal(result.generations.length, 1, "同じ材料での全文再生成を繰り返さない");
  assert.equal(result.candidate?.text, "その内容は公開資料では確認できていません。");
  assert.equal(result.candidate?.answerability, "unknown");
  assert.equal(result.judgeCalls.length, 1, "案内は固定なので判定を重ねない");
  assert.ok(result.diagnostics.some(item => item.code === "repair_skipped" && item.reason === "not_answerable"));
});

test("内容の裏付けや範囲で落ちたときは、案内に置き換えず却下する", async () => {
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "answerable", role: "direct" }),
    scores: call => call === 1 ? { target_match: .1, claims_supported: .1 } : allPass() });
  assert.ok(result.error instanceof JevPipelineError, "裏付けの無い内容を案内で隠さない");
  assert.equal((result.error as JevPipelineError).code, "ANSWER_REJECTED");
  assert.equal(result.candidate, undefined, "未検証の本文は返さない");
});

test("直接の支持が弱く、答えられる範囲も決まらないときは、生成せずに不足案内を返す", async () => {
  // 資料に直接の答えが無く、探索でも変わらない質問。主根拠が選ばれていても、生成で埋め合わせない。
  const result = await runCase({ evidence: pair, search: async () => [evidenceOf("extra:1", { documentId: "extra" })],
    settings: settings => { settings.beam.enabled = true; settings.limits.maxSerialStages = 8; },
    scope: () => ({ answerScope: "insufficient", role: "mixed", primary: "rev_a:0", support: 0,
      noul: { target_match: .5, direct_support: .1, background_support: .5 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 0, "支持が弱いまま生成しない");
  assert.equal(result.candidate?.text, "その内容は公開資料では確認できていません。");
  assert.ok(result.diagnostics.some(item => item.code === "triage_route" && item.reason === "insufficient"));
});

test("直接の支持が確認できている低確信の質問は、生成して部分回答を返す", async () => {
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "ambiguous", role: "mixed", primary: "rev_a:0", confidence: .2, support: 1,
      noul: { direct_support: .8, background_support: .8 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 1, "支持が確認できていれば生成する");
  assert.equal(result.candidate?.text, rawAnswer);
});

test("直前の会話を受ける指示語の質問は、支持が弱くても生成へ回して解決させる", async () => {
  const history: Turn[] = [{ role: "user", content: "いま参画しているプロジェクトを教えてください" },
    { role: "assistant", content: "Matsuri Projectに参画しています。" }];
  const result = await runCase({ evidence: pair, question: "そこでの担当範囲はどこまでですか？", history,
    scope: () => ({ answerScope: "insufficient", role: "mixed", primary: "rev_a:0", support: 0,
      noul: { target_match: .5, direct_support: .1, background_support: .5 } }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 1, "履歴を受ける指示語は生成へ回す");
  assert.deepEqual(result.generations[0].history, history, "生成へ同じ履歴を渡す");
});

test("履歴が無いまま直前の会話を指す質問は、対象を選ばず確認を返す", async () => {
  const result = await runCase({ evidence: pair, question: "そこでの担当範囲はどこまでですか？",
    scope: () => ({ answerScope: "answerable", role: "direct" }) });
  assert.equal(result.error, undefined);
  assert.equal(result.generations.length, 0, "対象を決められないので生成しない");
  assert.equal(result.candidate?.text, "どの対象・時期についてのお話か教えてください。");
});

test("選別が資料に答えが無いと判定した質問は、内容の裏付けで落ちても案内を返す", async () => {
  // 背景の支持はあるが答えが無い質問。作り話で落ちても、answer_scopeの判定と一致する案内へ落とす。
  const result = await runCase({ evidence: pair,
    scope: () => ({ answerScope: "insufficient", role: "background", primary: "rev_a:0", support: 1,
      noul: { target_match: .7, direct_support: .3, background_support: .9 } }),
    scores: () => ({ claims_supported: .1 }) });
  assert.equal(result.error, undefined, "本文なしの却下で終えない");
  assert.equal(result.generations.length, 2, "答えを含む可能性があるため生成し、直せる軸なので1回だけ作り直す");
  assert.equal(result.candidate?.text, "その内容は公開資料では確認できていません。");
  assert.ok(result.diagnostics.some(item => item.code === "jev_rejected" && item.reason === "claims_supported"),
    "落ちた理由は残す");
});
