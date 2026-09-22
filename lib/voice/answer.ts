import type { AnswerProvider, ChatRequest, Database, DiagnosticsCallback, EmbeddingProvider, Evidence, SourceVersion, Statement, VectorIndex } from "../types.ts";
import { KnowledgeRepository } from "../knowledge/repository.ts";
import { answer } from "../answer/engine.ts";
import { SpeechChunks } from "./audio.ts";
import type { SpeechAudio, SpeechProvider, VoiceEvent } from "./types.ts";
import type { JevPipeline } from "../answer/jev-pipeline.ts";
import { emptyContentExclusions, excludedContentReply } from "../security/content-exclusions.ts";
import type { InputEnvelope } from "./input/normalize.ts";

// /api/voice/chat: readinessとindex照合が2件、二つの利用制限が各3件。
const preflightQueries = 8;
const maxQueries = 50;
function withQueryBudget(db: Database, signal: AbortSignal): Database {
  let queries = preflightQueries;
  const consume = (count = 1) => {
    signal.throwIfAborted();
    if (queries + count > maxQueries) throw new Error("voice_query_limit");
    queries += count;
  };
  const wrap = (statement: Statement): Statement => ({
    bind(...values) { return wrap(statement.bind(...values)); },
    async all<T>() { consume(); return statement.all<T>(); },
    async first<T>() { consume(); return statement.first<T>(); },
    async run() { consume(); return statement.run(); }
  });
  return {
    prepare(sql) { return wrap(db.prepare(sql)); },
    // 回答経路には書込やbatchがない。追加時に無計上のSQLを通さない。
    async batch() { throw new Error("unexpected_voice_batch"); }
  };
}
class VoiceRepository extends KnowledgeRepository {
  override revalidate(evidence: Evidence[]) { return this.revalidateSnapshot(evidence); }
}

// 原文の順序と全体を保ち、TTSの出力上限に収まる長さへ分割する。
// 最初の塊だけ短くして、音声が早く出るようにする（読み終えて待つ時間を減らす）。
const firstPartMax = 80;
const partMax = 180;
// 上限までの最後の文の区切り。見つからなければ0。
function lastSentenceBoundary(chars: string[], limit: number): number {
  return chars.slice(0, limit)
    .map((char, index) => /[。！？!?\n]/u.test(char) ? index + 1 : 0)
    .filter(Boolean)
    .at(-1) ?? 0;
}

export function speechParts(text: string): string[] {
  const chars = Array.from(text), parts: string[] = [];
  while (chars.length) {
    let length = Math.min(parts.length ? partMax : firstPartMax, chars.length);
    if (length < chars.length) {
      const boundary = lastSentenceBoundary(chars, length);
      // 最初の文が長いときは、途中で切るより文の区切りまで待つ。
      if (!boundary && !parts.length) length = lastSentenceBoundary(chars, partMax) || length;
      else if (boundary) length = boundary;
    }
    const part = chars.splice(0, length).join("");
    if (part.trim()) parts.push(part);
  }
  return parts;
}

export async function* voiceAnswer(input: ChatRequest, deps: {
  repository: KnowledgeRepository; vector: VectorIndex; embedding: EmbeddingProvider; provider: AnswerProvider; speech: SpeechProvider;
  careerOverview?: string;
  diagnostics?: DiagnosticsCallback;
  jev?: JevPipeline;
  // falseのときは読み上げを生成しない（音声入力だけを使う）。
  speak?: boolean;
  // 入力の正規化結果。理解した質問の通知と、表示・音声化の前の遮断に使う。
  inputEnvelope?: InputEnvelope;
  // 正規化に使った時間を差し引いた、回答全体の残り時間。
  timeBudgetMs?: number;
}, signal: AbortSignal): AsyncGenerator<VoiceEvent> {
  // 除外方針はリポジトリが持つ。新しいインスタンスへも必ず引き継ぐ（落とすと遮断が効かなくなる）。
  // 方針を持たないリポジトリ（テストや旧経路）でも動くように、既定は「除外なし」にする。
  const policy = deps.repository.exclusions ?? emptyContentExclusions;
  const repository = new VoiceRepository(withQueryBudget(deps.repository.db, signal), deps.repository.ownerId, policy);
  const chunks = new SpeechChunks();
  let evidence: Evidence[] = [], sequence = 0;
  let sourceSet: SourceVersion[] | undefined;
  // 理解した質問は、回答より先に1回だけ知らせる。原文は非表示対象のときに渡さない。
  if (deps.inputEnvelope) {
    const envelope = deps.inputEnvelope;
    yield { type: "input-normalized", question: envelope.displayQuestion, resolution: envelope.resolution,
      edited: envelope.edited, blocked: envelope.blocked, confirm: envelope.confirm,
      raw: envelope.blocked ? "" : envelope.rawTranscript,
      ...(envelope.notice ? { notice: envelope.notice } : {}) };
    // 質問として成立していない発話（フィラーだけ）では、新しい検索も回答生成も始めない。
    if (!envelope.question) return;
  }
  let masked = false;
  const current = async () => {
    signal.throwIfAborted();
    if (evidence.length && !await repository.revalidateSnapshot(evidence, sourceSet)) throw new Error("voice_evidence_changed");
    signal.throwIfAborted();
  };
  for await (const event of answer(input, { ...deps, repository, ...(deps.timeBudgetMs === undefined ? {} : { timeBudgetMs: deps.timeBudgetMs }),
    onEvidence: (items, versions) => { evidence = items; sourceSet = versions; } }, signal)) {
    signal.throwIfAborted();
    if (event.type === "text") await current();
    // 表示と音声化の前に、非表示対象が混ざっていないかを機械で確認する。
    // 語を削って意味の変わった本文を、検証済みの回答として読み上げない。
    const text = event.type === "text" ? event.text : "";
    const answerId = event.type === "text" ? event.answerId : "";
    if (text && policy.matches(text)) {
      if (!masked) {
        masked = true;
        deps.diagnostics?.({ code: "voice_input_blocked", count: 1, reason: "answer_masked" });
        yield { type: "text", text: excludedContentReply, answerId };
      }
      continue;
    }
    if (masked && event.type === "text") continue;
    yield event;
    if (event.type !== "text") continue;
    if (deps.speak === false) continue;
    for (const part of speechParts(event.text)) {
      await current();
      const ttsStarted = performance.now();
      for await (const audio of chunks.read(deps.speech.synthesize(part, signal), signal)) {
        await current();
        yield { ...audio, type: "audio", answerId: event.answerId, sequence: sequence++ };
      }
      deps.diagnostics?.({ code: "tts_complete", count: 1, latencyMs: Math.round(performance.now() - ttsStarted) });
    }
  }
}
