import test from "node:test";
import assert from "node:assert/strict";
import type { AiBinding, Evidence } from "../lib/types.ts";
import { buildAnswerPlan, compactEvidence, compactScopeInstruction } from "../lib/answer/compact.ts";
import { visibleEvidenceContent } from "../lib/knowledge/evidence-text.ts";
import { defaultJevSettings, jevScopeDecision } from "../lib/answer/jev-settings.ts";
import { jevScopeAspectOptions, jevScopeNoPrimary, jevScopeNoulIds, jevScopeOrder, jevScopePrimaryEvidenceId,
  jevScopeEvidenceRoleId, jevScopeQuestions, jevScopeRequestedAspectId, jevScopeSupportStrengthId } from "../lib/ai/jev-scope.ts";
import type { ChoiceQuestion, JevQuestion, ParsedAnswer } from "../lib/ai/jev-primitives.ts";
import { TypeSafeJev, jevRules, type JevInput } from "../lib/ai/jev.ts";
import { WorkersAiJev } from "../lib/ai/jev-workers-ai.ts";

const evidenceOf = (index: number, overrides: Partial<Evidence> = {}): Evidence => ({
  id: `rev_${index}:0`, revisionId: `rev_${index}`, documentId: `doc_${index}`, title: `資料${index}`,
  content: `本文${index}です。2020年に担当しました。`, contentHash: `hash_${index}`, entities: [], kind: "chunk",
  rank: index + 1, ...overrides
});

// 選別（JEV①）の答えを型どおりに組み立て、decision へ合成する。
const decisionOf = (options: { answerScope?: string; role?: string; primary?: string; aspect?: string;
  noul?: Record<string, number>; skip?: string[]; question?: string; extra?: Record<string, ParsedAnswer> } = {},
  ids: readonly string[] = ["rev_0:0", "rev_1:0", "rev_2:0", "rev_3:0"]) => {
  const answers: Record<string, ParsedAnswer> = {
    answer_scope: { type: "choice", choice: options.answerScope ?? "answerable", confidence: .9 },
    evidence_role: { type: "choice", choice: options.role ?? "direct", confidence: .9 },
    primary_evidence: { type: "choice", choice: options.primary ?? jevScopeNoPrimary, confidence: .9 },
    support_strength: { type: "score", score: 3, levels: 4, confidence: .9 },
    ...(options.aspect === undefined ? {} : { [jevScopeRequestedAspectId]: { type: "choice" as const, choice: options.aspect, confidence: .9 } }),
    target_match: { type: "noul", value: .97 }, time_match: { type: "noul", value: .97 },
    direct_support: { type: "noul", value: options.noul?.direct_support ?? .97 },
    background_support: { type: "noul", value: options.noul?.background_support ?? .97 },
    causal_support: { type: "noul", value: options.noul?.causal_support ?? .97 },
    conflict_risk: { type: "noul", value: options.noul?.conflict_risk ?? .05 },
    ...(options.extra ?? {})
  };
  for (const id of options.skip ?? []) delete answers[id];
  return jevScopeDecision(options.question ?? "質問", { answers, asked: Object.keys(answers) }, defaultJevSettings(), ids);
};

test("要求項目の質問を足し、主根拠の選択肢へ渡した証拠をすべて並べる", () => {
  const evidence = Array.from({ length: 11 }, (_, index) => evidenceOf(index));
  const { questions, asked, criteria } = jevScopeQuestions(evidence, jevScopeOrder.length);
  assert.ok(asked.includes(jevScopeRequestedAspectId), "段階の上限内で要求項目を聞く");
  const aspectAt = asked.indexOf(jevScopeRequestedAspectId);
  assert.ok(aspectAt < asked.indexOf("background_support"), "背景の有無より先に聞く");
  const aspect = questions[jevScopeRequestedAspectId] as ChoiceQuestion;
  assert.deepEqual(Object.keys(aspect.criteria), Object.keys(jevScopeAspectOptions), "要求項目の選択肢");
  assert.ok(jevScopeAspectOptions.value.includes("価値観"), "valueは価値観を指す");
  const primary = questions[jevScopePrimaryEvidenceId] as ChoiceQuestion;
  assert.ok(evidence.every(item => item.id in primary.criteria), "渡した証拠をすべて選択肢に含める");
  assert.ok("rev_10:0" in primary.criteria, "11件目の原文も選択肢に含める");
  assert.ok(jevScopeNoPrimary in primary.criteria, "主根拠なしの選択肢を残す");
  assert.equal(criteria[evidence[10].id], evidence[10].title.slice(0, 80));
  // 既存の質問は残し、段階内の上限を超える低優先の軸だけを聞かない。
  assert.equal(jevScopeOrder.length, 10);
  assert.ok(asked.includes(jevScopeEvidenceRoleId), "役割の判定は残す");
  assert.ok(asked.includes(jevScopeSupportStrengthId), "Choice・Noul・Scoreを1回で聞く");
  assert.deepEqual(jevScopeNoulIds.filter(axis => !asked.includes(axis)), ["time_match"], "上限を超える低優先の軸は聞かない");
  assert.equal(asked.length, jevScopeOrder.length, "段階内の上限は超えない");
  assert.equal(asked.includes("time_match"), false, "聞かなかった軸は明示的に外す（否定的な推測をしない）");
});

test("選別の答えを requestedAspect として decision へ写す", () => {
  assert.equal(decisionOf({ aspect: "origin" }).requestedAspect, "origin");
  assert.equal(decisionOf({}).requestedAspect, undefined, "聞かなければ付けない");
});

test("直接・背景の支持を、判定した範囲だけで decision へ写す", () => {
  const supported = decisionOf({});
  assert.equal(supported.directSupported, true);
  assert.equal(supported.backgroundSupported, true);
  // 矛盾があるときは、直接支持が高くても十分とみなさない。
  const conflicted = decisionOf({ noul: { conflict_risk: .95 } });
  assert.equal(conflicted.contradiction, true);
  assert.equal(conflicted.directSupported, false);
  assert.equal(decisionOf({ noul: { direct_support: .1 } }).directSupported, false, "閾値未満はfalse");
  // 聞いていない軸は付けない（否定的な推測をしない）。
  const skipped = decisionOf({ skip: ["direct_support", "background_support"] });
  assert.equal(skipped.directSupported, undefined);
  assert.equal(skipped.backgroundSupported, undefined);
});

test("選ばれた主根拠だけを直接にし、同文書の補足と候補は未確定で残す", () => {
  const evidence = [evidenceOf(0, { content: "公開の段落です。\n\n非公開の段落です。", excludedStatements: ["非公開の段落"] }),
    evidenceOf(1, { documentId: "doc_0", title: "同文書の限定" }),
    evidenceOf(2, { kind: "exact_fact", documentId: "doc_9", title: "別文書のFact" }),
    evidenceOf(3, { documentId: "doc_3", title: "無関係" })];
  const plan = buildAnswerPlan("リーフ検証プロジェクトの担当は？", evidence, decisionOf({ primary: "rev_0:0", aspect: "role" }));
  const direct = plan.topics![0];
  assert.equal(direct.role, "direct"); assert.equal(direct.aspect, "role"); assert.equal(direct.unconfirmed, false);
  assert.equal(direct.query, "リーフ検証プロジェクトの担当は？");
  assert.deepEqual(direct.sources.map(source => source.id), ["rev_0:0"], "直接の答えは主根拠だけ");
  assert.equal(direct.sources[0].text, "公開の段落です。", "見えている原文をそのまま載せる");
  assert.deepEqual(direct.references, [], "主根拠以外を直接に混ぜない");
  assert.ok(direct.preservation.includes("否定"), "主体・時期・単位・条件・否定を保つ指示");
  // 同文書の補足は原文つき、それ以外は本文を繰り返さずIDで参照する。
  const support = plan.topics![1];
  assert.equal(support.role, "background"); assert.equal(support.unconfirmed, true);
  assert.deepEqual(support.sources.map(source => source.id), ["rev_1:0"], "同文書の補足は原文つき");
  assert.deepEqual(support.references, ["rev_2:0", "rev_3:0"], "残りはIDだけ");
  assert.equal(plan.topics!.flatMap(topic => topic.sources).length, 2, "候補本文を丸ごと繰り返さない");
  // 既存のAnswerPlanの項目はそのまま保つ。
  assert.equal(plan.answerability, "answerable"); assert.equal(plan.primaryEvidenceId, "rev_0:0");
  assert.equal(plan.backgroundOnly, false); assert.equal(plan.causalityUnconfirmed, false);
  assert.equal(typeof plan.directive, "string");
  assert.equal(direct.sources[0].text, visibleEvidenceContent(evidence[0]));
});

test("主根拠が無いときは候補をIDで参照し、部分の残りは missing にする", () => {
  const evidence = [evidenceOf(0), evidenceOf(1)];
  const ids = ["rev_0:0", "rev_1:0"];
  // 答えられる範囲があるなら、棄権にせず候補を使える形で残す。
  const partial = buildAnswerPlan("どんな成果がありましたか？", evidence, decisionOf({ answerScope: "partial", role: "background" }, ids));
  assert.deepEqual(partial.topics!.map(topic => topic.role), ["background", "missing"]);
  assert.deepEqual(partial.topics![0].references, ids, "候補はIDで参照する");
  assert.deepEqual(partial.topics![0].sources, [], "本文は繰り返さない");
  assert.equal(partial.topics![1].unconfirmed, true);
  assert.equal(partial.answerability, "partial");
  // 対象が決まらないときは missing として残す。
  const missing = buildAnswerPlan("どんな成果がありましたか？", evidence, decisionOf({ answerScope: "ambiguous", role: "irrelevant" }, ids));
  assert.equal(missing.topics![0].role, "missing"); assert.equal(missing.topics![0].unknown, true);
  assert.deepEqual(missing.topics![0].references, ids);
  // 主根拠が選ばれていれば、背景だけの判定でも原文で使える。
  const background = buildAnswerPlan("どんな成果がありましたか？", evidence, decisionOf({ answerScope: "partial", role: "background", primary: "rev_0:0" }, ids));
  assert.equal(background.topics![0].role, "background");
  assert.deepEqual(background.topics![0].sources.map(source => source.id), ["rev_0:0"]);
});

test("複数の質問文は、論点ごとに選ばれた原文を対応づける", () => {
  const evidence = [evidenceOf(0, { title: "担当", content: "要件整理を担当しました。" }),
    evidenceOf(1, { title: "成果", content: "3件を公開しました。" })];
  const ids = ["rev_0:0", "rev_1:0"];
  const question = "担当は？成果は？";
  const { questions, asked } = jevScopeQuestions(evidence, 10, question);
  assert.ok(asked.includes("topic_0_primary") && asked.includes("topic_1_primary"), "論点ごとの主根拠を聞く");
  const first = questions["topic_0_primary"] as ChoiceQuestion;
  assert.ok(first.instructions.includes("担当は？"), "元の論点をそのまま示す");
  assert.ok(ids.every(id => id in first.criteria), "既存の証拠IDだけを選択肢にする");
  const decision = decisionOf({ question, extra: {
    topic_0_primary: { type: "choice", choice: "rev_0:0", confidence: .9 },
    topic_1_primary: { type: "choice", choice: "rev_1:0", confidence: .9 } } }, ids);
  assert.deepEqual(decision.topics?.map(topic => [topic.query, topic.primaryEvidenceId, topic.evaluated]),
    [["担当は？", "rev_0:0", true], ["成果は？", "rev_1:0", true]]);
  const plan = buildAnswerPlan(question, evidence, decision);
  const direct = plan.topics!.filter(topic => topic.role === "direct");
  assert.deepEqual(direct.map(topic => topic.sources.map(source => source.text)),
    [["要件整理を担当しました。"], ["3件を公開しました。"]], "論点ごとに、選ばれた原文を載せる");
});

test("段階内の枠が小さいときは、論点は未評価のまま残し、直接とはしない", () => {
  const evidence = [evidenceOf(0), evidenceOf(1)];
  const ids = ["rev_0:0", "rev_1:0"];
  const question = "担当は？成果は？";
  const { asked } = jevScopeQuestions(evidence, 9, question);
  assert.ok(asked.includes("topic_0_primary") && !asked.includes("topic_1_primary"), "枠が無ければ2つ目は聞かない");
  const decision = decisionOf({ question, extra: { topic_0_primary: { type: "choice", choice: "rev_0:0", confidence: .9 } } }, ids);
  assert.equal(decision.topics?.[0].evaluated, true);
  assert.equal(decision.topics?.[1].evaluated, false);
  const plan = buildAnswerPlan(question, evidence, decision);
  const second = plan.topics!.find(topic => topic.query === "成果は？")!;
  assert.equal(second.role, "missing"); assert.equal(second.unconfirmed, true);
  assert.deepEqual(second.sources, [], "聞いていない論点を直接の答えにしない");
  assert.deepEqual(second.references, ids, "候補はIDで見えるまま残す");
});

test("同じplanを公式HTTPとWorkers AIの点検stateへ同じ形で渡す", async t => {
  const evidence = [evidenceOf(0)];
  const plan = buildAnswerPlan("担当は？", evidence, decisionOf({ primary: "rev_0:0", aspect: "role" }, ["rev_0:0"]));
  const input: JevInput = { question: "担当は？", history: [], evidence, candidate: "要件整理を担当しました。",
    answerScope: "候補資料の直接の根拠を使って答えてください。", answerPlan: plan };
  const noulAnswers = (questions: Record<string, JevQuestion>) => Object.fromEntries(
    Object.keys(questions).map(axis => [axis, { type: "noul" as const, noul: .9 }]));
  let http: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { questions: Record<string, JevQuestion>; state: Record<string, unknown> };
    http = body.state;
    return Response.json({ answers: noulAnswers(body.questions) });
  });
  await new TypeSafeJev("dummy-key").check(input, new AbortController().signal);
  let workers: Record<string, unknown> | undefined;
  const ai: AiBinding = { async run(_model: string, value: Record<string, unknown>) {
    workers = value.state as Record<string, unknown>;
    return { result: { answers: noulAnswers(value.questions as Record<string, JevQuestion>) } }; } };
  await new WorkersAiJev(ai).check(input, new AbortController().signal);
  assert.deepEqual(workers, http, "同じstateを送る");
  assert.deepEqual((workers as { answer_plan: unknown }).answer_plan, JSON.parse(JSON.stringify(plan)), "同じplanを渡す");
  assert.equal((workers as { answer_scope?: string }).answer_scope, input.answerScope, "回答可能範囲も同じ");
});

test("点検の指示は、planを根拠にも採点結果にもしない", () => {
  assert.ok(jevRules.some(rule => rule.includes("answer_plan") && rule.includes("根拠本文ではない")), "planを根拠にしない");
  assert.ok(jevRules.some(rule => rule.includes("背景") && rule.includes("直接の答え")), "背景を直接の答えにしない");
  assert.ok(compactScopeInstruction.includes("topics") && compactScopeInstruction.includes("根拠ではありません"), "生成へ同じ制約を伝える");
});

test("応募先の会社を尋ねる質問は、資料に無いことの明示を指示へ入れる", () => {
  const company = decisionOf({ question: "なぜ当社に応募したのですか？", primary: "rev_0:0", aspect: "origin" });
  const directive = company.directives.join("");
  assert.ok(directive.includes("応募先の会社に固有"), "会社に固有の部分は資料に無いと伝える");
  assert.ok(directive.includes("読み替え"), "別の会社・過去の勤務先へ読み替えさせない");
  const other = decisionOf({ question: "前職では何を担当しましたか？", primary: "rev_0:0" });
  assert.ok(!other.directives.join("").includes("応募先の会社に固有"), "会社を尋ねていない質問には足さない");
});

test("生成と判定へ渡す根拠は、長い本文を切ってもFactは切らない", () => {
  const long = "あ".repeat(1_400) + "。";
  const evidence = [evidenceOf(0, { content: long }),
    evidenceOf(1, { kind: "exact_fact", content: "2024年に独立し、小規模事業者の業務整理を支援しています。" })];
  const compact = compactEvidence(evidence);
  assert.ok(compact[0].text.length < long.length && compact[0].text.length <= 900, "長い本文は区切りまでで切る");
  assert.equal(compact[1].text, "2024年に独立し、小規模事業者の業務整理を支援しています。", "数値を持つFactは切らない");
  assert.deepEqual(compact.map(item => item.id), evidence.map(item => item.id), "根拠IDは変えない");
});
