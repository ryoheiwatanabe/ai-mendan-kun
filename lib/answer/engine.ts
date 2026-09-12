import type { AnswerProvider, Answerability, ChatEvent, ChatRequest, EmbeddingProvider, Evidence, Segment, VectorIndex } from "../types.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { retrieve } from "../knowledge/retrieval.ts";
import { asksForDecision, isInjection } from "../security/request.ts";
import { highRisk, validateSegment } from "./guard.ts";
import { conversationReply } from "./conversation.ts";

const unknown = "その点を説明できる情報は、公開用の記録にはまだありません。面談で本人に確認してみてください。";
const ambiguous = "どの時期・プロジェクトについて知りたいか、もう少し詳しく教えてください。";

export async function* answer(input: ChatRequest, deps: {
  repository: KnowledgeRepository; vector: VectorIndex; embedding: EmbeddingProvider; provider: AnswerProvider;
  onEvidence?: (evidence: Evidence[]) => void;
}, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const start = performance.now();
  const answerId = crypto.randomUUID();
  let first: number | null = null, displayed = 0, similarity: number | null = null;
  const event = (text: string): ChatEvent => {
    signal.throwIfAborted();
    first ??= performance.now() - start;
    displayed += text.length;
    return { type: "text", text, answerId };
  };
  const done = (answerability: Answerability): ChatEvent => {
    signal.throwIfAborted();
    return { type: "done", answerId, answerability,
      latencyMs: Math.round(performance.now() - start), firstTextMs: first === null ? null : Math.round(first),
      retrievalSimilarityPercent: (answerability === "answerable" || answerability === "partial") && similarity !== null ? Math.round(similarity * 100) : null };
  };
  yield { type: "start", answerId };
  if (isInjection(input.message)) {
    yield event("本人が公開用に承認した経験や考え方についてお答えします。気になる仕事や経験を、具体的に聞いてみてください。");
    yield done("unknown"); return;
  }
  if (asksForDecision(input.message)) {
    yield event("参加や入社、契約条件への承諾は本人が判断します。このAIでは確約できないため、面談で本人に確認してください。");
    yield done("unknown"); return;
  }
  const conversational = conversationReply(input.message);
  if (conversational) { yield event(conversational); yield done("answerable"); return; }
  const result = await retrieve({ question: input.message, history: input.history, ...deps, signal });
  deps.onEvidence?.(result.evidence);
  if (result.conflicts.length) {
    yield event("この点は、公開用の記録に一致しない情報があるため断定できません。正確な内容は本人に確認してください。");
    yield done("ambiguous"); return;
  }
  if (!result.evidence.length) { yield event(unknown); yield done("unknown"); return; }
  const risky = highRisk(input.message, result.evidence.flatMap(item => item.entities));
  const pending: Segment[] = [];
  let rejected = false, complete = false;
  const recordSimilarity = (ids: string[]) => {
    for (const id of ids) {
      const score = result.similarityScores.get(id);
      if (score !== undefined) similarity = Math.max(similarity ?? 0, score);
    }
  };
  const validate = async (segment: Segment) => {
    const checked = validateSegment(segment, result.evidence, /適性|向いて|任せ|相性|整理|採用するメリット/.test(input.message));
    if (!checked.ok || !checked.text || displayed + checked.text.length > 1100) return null;
    const sources = segment.evidenceIds.map(id => result.evidence.find(item => item.id === id)!).filter(Boolean);
    if (!await deps.repository.revalidate(sources)) return null;
    return { text: checked.text, matchedEvidenceIds: checked.matchedEvidenceIds ?? [] };
  };
  for await (const output of deps.provider.stream({ question: input.message, history: input.history, evidence: result.evidence, highRisk: risky }, signal)) {
    signal.throwIfAborted();
    if (output.type === "segment") {
      if (risky) { pending.push(output.segment); continue; }
      const checked = await validate(output.segment);
      if (!checked) { rejected = true; continue; }
      recordSimilarity(checked.matchedEvidenceIds);
      yield event((displayed ? "\n\n" : "") + checked.text);
    } else {
      complete = true;
      let state = output.payload.answerability;
      if (risky) {
        if (state === "unknown" || state === "ambiguous") pending.length = 0;
        const checked: { text: string; matchedEvidenceIds: string[] }[] = [];
        for (const segment of pending) {
          const validated = await validate(segment);
          if (!validated) { rejected = true; break; }
          checked.push(validated);
        }
        // 高リスク回答は一つでも根拠確認が失敗したら全体を保留する。
        if (!rejected && checked.map(item => item.text).join("\n\n").length <= 1100 && await deps.repository.revalidate(result.evidence.filter(item => pending.some(segment => segment.evidenceIds.includes(item.id))))) {
          for (const item of checked) {
            recordSimilarity(item.matchedEvidenceIds);
            yield event((displayed ? "\n\n" : "") + item.text);
          }
        }
      }
      if (!displayed) {
        state = state === "ambiguous" ? "ambiguous" : "unknown";
        yield event(state === "ambiguous" ? ambiguous : unknown);
      } else if (rejected || state !== "answerable") {
        state = "partial";
        yield event("\n\nこの記録だけでは、質問のすべてにはお答えできません。詳しい点は本人に確認してください。");
      }
      yield done(state);
    }
  }
  if (!complete) throw new Error("incomplete_answer");
}
