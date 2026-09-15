import { mkdir, open, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnswerProvider, ChatEvent, ChatRequest, EmbeddingProvider, Turn } from "../lib/types.ts";
import type { SpeechProvider, VoiceEvent } from "../lib/voice/types.ts";
import { KnowledgeRepository } from "../lib/knowledge/repository.ts";
import { answer as defaultAnswer } from "../lib/answer/engine.ts";
import { voiceAnswer as defaultVoiceAnswer } from "../lib/voice/answer.ts";
import { LocalDatabase, FakeVector, embedding as defaultEmbedding } from "../tests/helpers.ts";
import { approveImport, prepareImport } from "../lib/knowledge/import.ts";

// ---- options and provider contracts ----

export type EvaluationProviderMeta = { provider: string; model?: string };
export type PricingMeta = { model: string; provider?: string; inputPerToken?: number; outputPerToken?: number };

export type EvaluationProviders = {
  provider: AnswerProvider;
  model?: string;
  meta?: EvaluationProviderMeta;
  pricing?: PricingMeta;
  engine?: typeof defaultAnswer;
  voiceEngine?: typeof defaultVoiceAnswer;
  speech?: SpeechProvider;
};
export type EvaluationAdapter = { createEvaluationProviders(): Promise<EvaluationProviders> | EvaluationProviders };

export type RunGroundedEvaluationOptions = {
  provider?: AnswerProvider;
  adapter?: EvaluationAdapter | string;
  cases?: string[];
  variants?: number;
  variantIndices?: number[];
  label?: string;
  model?: string;
  timeoutMs?: number;
  continueOnFailure?: boolean;
  outputDirectory?: string;
  engine?: typeof defaultAnswer;
  voiceEngine?: typeof defaultVoiceAnswer;
  speech?: SpeechProvider;
  pricing?: PricingMeta;
};

type Usage = { input: number; output: number };
type UsageCell = Usage | "unknown";
type Timing = { firstTextMs: number | null; firstAudioMs: number | null; totalElapsedMs: number };

type RunRecord = {
  runIndex: number;
  caseId: string;
  category: string;
  question: string;
  variant: number;
  model: string | null;
  provider: string | null;
  answerText: string;
  answerCodePoints: number;
  answerability: string | null;
  answerabilityMatched: boolean;
  timing: Timing;
  usage: UsageCell;
  usageByCallKind: Record<string, UsageCell>;
  callCounts: Record<string, number>;
  ttsCalls: number | null;
  audioChunks: number | null;
  estimatedCost: { input: number | null; output: number | null; total: number | null; pricingModel?: string } | null;
  semanticReview: "pending";
  requiredClaims: string[];
  forbiddenClaims: string[];
  maxCodePoints: number;
  notes: string;
  completed: boolean;
  withinLength: boolean;
  withinCalls: boolean;
  status: "pass" | "fail";
  errorCode: string | null;
  diagnostics: {code: string; count?: number; latencyMs?: number; inputTokens?: number; outputTokens?: number}[];
};

const MAX_GENERATIONS = 2;
const MAX_VERIFICATIONS = 2;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "grounded-acceptance.json");
const OUTPUT_ROOT = join(REPO_ROOT, ".local", "grounded-evaluation");

// ---- fixture schema ----

type FixtureDocument = { id: string; title: string; content: string };
type FixtureCase = {
  id: string;
  category: string;
  questions: string[];
  history: Turn[];
  expected: {
    answerability: string[];
    requiredClaims: string[];
    forbiddenClaims: string[];
    maxCodePoints: number;
    notes: string;
  };
};
type Fixture = { version: 1; fictional: true; documents: FixtureDocument[]; cases: FixtureCase[] };

function assertFixture(value: unknown): Fixture {
  if (!value || typeof value !== "object") throw new Error("fixture_not_object");
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error("fixture_version_must_be_1");
  if (v.fictional !== true) throw new Error("fixture_must_be_fictional");
  if (!Array.isArray(v.documents) || v.documents.length === 0) throw new Error("fixture_documents_required");
  if (!Array.isArray(v.cases) || v.cases.length !== 20) throw new Error("fixture_cases_required");
  const docIds = new Set<string>();
  for (const raw of v.documents as unknown[]) {
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id) throw new Error("fixture_document_id");
    if (docIds.has(d.id)) throw new Error("fixture_document_id_duplicate");
    docIds.add(d.id);
    if (typeof d.title !== "string" || typeof d.content !== "string") throw new Error("fixture_document_shape");
  }
  const caseIds = new Set<string>();
  for (const raw of v.cases as unknown[]) {
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) throw new Error("fixture_case_id");
    if (caseIds.has(c.id)) throw new Error("fixture_case_id_duplicate");
    caseIds.add(c.id);
    if (typeof c.category !== "string") throw new Error("fixture_case_category");
    if (!Array.isArray(c.questions) || c.questions.length !== 3) throw new Error("fixture_case_questions_must_be_3");
    if (!Array.isArray(c.history)) throw new Error("fixture_case_history");
    const e = c.expected as Record<string, unknown> | undefined;
    if (!e) throw new Error("fixture_case_expected");
    for (const key of ["answerability", "requiredClaims", "forbiddenClaims"] as const) {
      if (!Array.isArray(e[key])) throw new Error("fixture_case_expected_array:" + key);
    }
    if (typeof e.maxCodePoints !== "number" || e.maxCodePoints <= 0) throw new Error("fixture_case_max_code_points");
    if (typeof e.notes !== "string") throw new Error("fixture_case_notes");
  }
  return value as Fixture;
}

// ---- harness: one independent import per fixture document ----

type Harness = {
  vector: FakeVector;
  repository: KnowledgeRepository;
  embedding: EmbeddingProvider;
  close: () => void;
};

async function buildHarness(fixtureValue: Fixture): Promise<Harness> {
  const db = new LocalDatabase();
  const harnessEmbedding: EmbeddingProvider = { embed: (text, signal) => defaultEmbedding.embed(text, signal) };
  const vector = new FakeVector();
  for (const doc of fixtureValue.documents) {
    const bundle = {
      version: 1,
      ownerId: "grounded-eval",
      documentId: doc.id,
      title: doc.title,
      visibility: "public" as const,
      verification: "self_reported" as const,
      entities: [] as string[],
      content: doc.content,
      facts: [] as unknown[]
    };
    const prepared = await prepareImport(bundle);
    await approveImport({
      db,
      vector,
      embedding: harnessEmbedding,
      prepared,
      approvalHash: prepared.hash,
      signal: new AbortController().signal
    });
  }
  const repository = new KnowledgeRepository(db, "grounded-eval");
  return { repository, vector, embedding: harnessEmbedding, close: () => db.close() };
}

// ---- usage extraction ----

function extractUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const u = (value as Record<string, unknown>).usage;
  if (!u || typeof u !== "object") return null;
  const input = (u as Record<string, unknown>).input;
  const output = (u as Record<string, unknown>).output;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { input, output };
}

type Meter = { counts: Record<string, number>; usage: {kind: string; value: UsageCell}[] };
function newMeter(): Meter { return {counts: {}, usage: []}; }
function meterCell(meter: Meter, kind?: string): UsageCell {
  const entries = meter.usage.filter(item => kind === undefined || item.kind === kind);
  if (entries.some(item => item.value === "unknown")) return "unknown";
  return entries.reduce<Usage>((sum, item) => {
    if (item.value !== "unknown") { sum.input += item.value.input; sum.output += item.value.output; }
    return sum;
  }, {input: 0, output: 0});
}
function wrapProviderForCase(base: AnswerProvider, meter: Meter): AnswerProvider {
  const begin = (kind: string) => {
    const limit = kind === "stream" ? MAX_GENERATIONS : MAX_VERIFICATIONS;
    if ((meter.counts[kind] ?? 0) >= limit) throw new GuardError("model_call_limit");
    meter.counts[kind] = (meter.counts[kind] ?? 0) + 1;
    const record = {kind, value: "unknown" as UsageCell};
    meter.usage.push(record);
    return record;
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "stream") return async function* (...args: Parameters<AnswerProvider["stream"]>) {
        const record = begin(args[0].purpose === "verify" ? "verify" : "stream");
        for await (const event of target.stream(...args)) {
          if (event.type === "complete") record.value = extractUsage(event) ?? "unknown";
          yield event;
        }
      };
      const value = Reflect.get(target, prop, target);
      if (prop === "verify" && typeof value === "function") return async (...args: unknown[]) => {
        const record = begin("verify");
        const result = await value.apply(target, args);
        record.value = extractUsage(result) ?? "unknown";
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function wrapSpeechForCase(base: SpeechProvider, meter: Meter): SpeechProvider {
  return new Proxy(base as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const name = String(prop);
      if (name === "transcribe") return (value as SpeechProvider["transcribe"]).bind(target);
      if (name === "synthesize") {
        return function (text: string, signal: AbortSignal) {
          meter.counts.tts = (meter.counts.tts ?? 0) + 1;
          return (value as SpeechProvider["synthesize"]).apply(target, [text, signal]);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    }
  }) as unknown as SpeechProvider;
}

// ---- single run ----

class GuardError extends Error {
  constructor(code: string) { super(code); this.name = "GuardError"; }
}

type CaseOutput = {
  answerText: string;
  answerability: string | null;
  completed: boolean;
  firstTextMs: number | null;
  firstAudioMs: number | null;
  audioChunks: number;
  totalElapsedMs: number;
  errorCode: string | null;
  diagnostics: {code: string; count?: number; latencyMs?: number; inputTokens?: number; outputTokens?: number}[];
};

async function runOnce(
  harness: Harness,
  engine: typeof defaultAnswer,
  provider: AnswerProvider,
  speech: SpeechProvider | undefined,
  voiceEngine: typeof defaultVoiceAnswer | undefined,
  evalCase: FixtureCase,
  question: string,
  timeoutMs: number
): Promise<CaseOutput> {
  const start = performance.now();
  let firstTextMs: number | null = null;
  let firstAudioMs: number | null = null;
  let answerText = "";
  let answerability: string | null = null;
  let audioChunks = 0;
  let completed = false;
  let errorCode: string | null = null;
  const diagnostics: CaseOutput["diagnostics"] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request: ChatRequest = { mode: "meeting_text", message: question, history: evalCase.history };
    const deps = {
      repository: harness.repository,
      vector: harness.vector,
      embedding: harness.embedding,
      provider,
      diagnostics: (event: CaseOutput["diagnostics"][number]) => {diagnostics.push(event);}
    };
    const source: AsyncIterable<VoiceEvent> = speech && voiceEngine
      ? voiceEngine(request, { ...deps, speech }, controller.signal)
      : engine(request, deps, controller.signal);
    for await (const event of source) {
      const e = event as { type: string } & Record<string, unknown>;
      if (e.type === "text" && typeof e.text === "string") {
        if (firstTextMs === null) firstTextMs = performance.now() - start;
        answerText += e.text;
      } else if (e.type === "audio") {
        if (firstAudioMs === null) firstAudioMs = performance.now() - start;
        audioChunks += 1;
      } else if (e.type === "done") {
        if (typeof e.answerability === "string") answerability = e.answerability;
        completed = true;
      } else if (e.type === "error") {
        errorCode = typeof e.code === "string" && /^[a-z_]{1,64}$/.test(e.code) ? e.code : "engine_error";
      }
    }
  } catch (error) {
    errorCode = error instanceof GuardError ? error.message : "engine_failure";
  } finally {
    clearTimeout(timer);
  }
  return {
    answerText,
    answerability,
    completed: completed && errorCode === null,
    firstTextMs,
    firstAudioMs,
    audioChunks,
    totalElapsedMs: performance.now() - start,
    errorCode,
    diagnostics
  };
}

async function runCase(
  harness: Harness,
  engine: typeof defaultAnswer,
  baseProvider: AnswerProvider,
  baseSpeech: SpeechProvider | undefined,
  voiceEngine: typeof defaultVoiceAnswer | undefined,
  model: string | null,
  providerName: string | null,
  pricing: PricingMeta | undefined,
  evalCase: FixtureCase,
  question: string,
  variant: number,
  timeoutMs: number
): Promise<RunRecord> {
  const meter = newMeter();
  const provider = wrapProviderForCase(baseProvider, meter);
  const speech = baseSpeech ? wrapSpeechForCase(baseSpeech, meter) : undefined;
  const output = await runOnce(harness, engine, provider, speech, voiceEngine, evalCase, question, timeoutMs);
  const errorCode = output.errorCode;
  const ttsCalls = speech ? (meter.counts.tts ?? 0) : null;
  const answerCodePoints = Array.from(output.answerText).length;
  const withinLength = answerCodePoints <= evalCase.expected.maxCodePoints;
  const withinCalls = (meter.counts.stream ?? 0) <= MAX_GENERATIONS && (meter.counts.verify ?? 0) <= MAX_VERIFICATIONS;
  const answerabilityMatched = output.answerability !== null && evalCase.expected.answerability.includes(output.answerability);
  const completed = output.completed && errorCode === null;
  const status = completed && withinLength && withinCalls && answerabilityMatched ? "pass" : "fail";
  const usageByKind: Record<string, UsageCell> = {};
  for (const [kind, count] of Object.entries(meter.counts)) {
    if (kind !== "tts") usageByKind[kind] = count === 0 ? {input: 0, output: 0} : meterCell(meter, kind);
  }
  const usage: UsageCell = meterCell(meter);
  let estimatedCost: RunRecord["estimatedCost"] = null;
  if (pricing && pricing.inputPerToken !== undefined && pricing.outputPerToken !== undefined && usage !== "unknown") {
    const input = usage.input * pricing.inputPerToken;
    const outputCost = usage.output * pricing.outputPerToken;
    estimatedCost = { input, output: outputCost, total: input + outputCost, pricingModel: pricing.model };
  }
  return {
    runIndex: 0,
    caseId: evalCase.id,
    category: evalCase.category,
    question,
    variant,
    model,
    provider: providerName,
    answerText: output.answerText,
    answerCodePoints,
    answerability: output.answerability,
    answerabilityMatched,
    timing: { firstTextMs: output.firstTextMs, firstAudioMs: output.firstAudioMs, totalElapsedMs: output.totalElapsedMs },
    usage,
    usageByCallKind: usageByKind,
    callCounts: { ...meter.counts },
    ttsCalls,
    audioChunks: speech ? output.audioChunks : null,
    estimatedCost,
    semanticReview: "pending",
    requiredClaims: evalCase.expected.requiredClaims,
    forbiddenClaims: evalCase.expected.forbiddenClaims,
    maxCodePoints: evalCase.expected.maxCodePoints,
    notes: evalCase.expected.notes,
    completed,
    withinLength,
    withinCalls,
    status,
    errorCode,
    diagnostics: output.diagnostics
  };
}

// ---- stats ----

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function groupStats(records: RunRecord[]) {
  const total = records.map(r => r.timing.totalElapsedMs);
  const firstText = records.map(r => r.timing.firstTextMs).filter((v): v is number => v !== null);
  const firstAudio = records.map(r => r.timing.firstAudioMs).filter((v): v is number => v !== null);
  const repaired = records.filter(r => (r.callCounts.stream ?? 0) > 1).length;
  return {
    n: records.length,
    firstTextSamples: firstText.length,
    firstAudioSamples: firstAudio.length,
    p50FirstTextMs: percentile(firstText, 50),
    p95FirstTextMs: percentile(firstText, 95),
    p50FirstAudioMs: percentile(firstAudio, 50),
    p95FirstAudioMs: percentile(firstAudio, 95),
    p50TotalMs: percentile(total, 50),
    p95TotalMs: percentile(total, 95),
    repairRate: records.length === 0 ? null : repaired / records.length,
    passCount: records.filter(r => r.status === "pass").length,
    failCount: records.filter(r => r.status === "fail").length
  };
}

// ---- output dir ----

function assertOutputDirectory(requested?: string): string {
  const root = resolve(OUTPUT_ROOT);
  const target = resolve(requested ? requested : root);
  const targetReal = existsSync(target) ? realpathSync(target) : target;
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) throw new Error("output_directory_outside_local");
  return targetReal;
}

async function openRunWriter(dir: string, runId: string) {
  const path = join(dir, runId + ".ndjson");
  const handle = await open(path, "wx", 0o600);
  return {
    path,
    async write(record: unknown) {
      await handle.writeFile(JSON.stringify(record) + "\n");
      await handle.datasync();
    },
    async close() { await handle.close(); }
  };
}

// ---- public API ----

export async function runGroundedEvaluation(options: RunGroundedEvaluationOptions) {
  const startedAt = new Date().toISOString();
  const dataFile = FIXTURE_PATH;
  if (!existsSync(dataFile)) throw new Error("fixture_missing");
  const fixtureValue = assertFixture(JSON.parse(await readFile(dataFile, "utf8")));
  const variants = options.variants ?? 1;
  if (!Number.isInteger(variants) || variants < 1 || variants > 3) throw new Error("variants_out_of_range");
  const variantIndices = options.variantIndices ?? Array.from({length: variants}, (_, index) => index);
  if (!variantIndices.length || new Set(variantIndices).size !== variantIndices.length || variantIndices.some(index => !Number.isInteger(index) || index < 0 || index > 2)) throw new Error("variant_indices_out_of_range");

  // Provider resolution: direct provider wins; adapter is a fallback that must
  // return a fully-formed EvaluationProviders object.
  let providers: EvaluationProviders;
  if (options.provider) {
    providers = { provider: options.provider, model: options.model };
  } else if (options.adapter) {
    const adapter = typeof options.adapter === "string"
      ? (await import(pathToFileURL(resolve(options.adapter)).href) as EvaluationAdapter)
      : options.adapter;
    const resolved = await Promise.resolve(adapter.createEvaluationProviders());
    if (!resolved || !resolved.provider) throw new Error("provider_resolution_failed");
    providers = resolved;
  } else {
    throw new Error("provider_or_adapter_required");
  }

  const engine = options.engine ?? providers.engine ?? defaultAnswer;
  const voiceEngine = options.voiceEngine ?? providers.voiceEngine ?? defaultVoiceAnswer;
  const speech = options.speech ?? providers.speech;
  const model = options.model ?? providers.model ?? providers.meta?.model ?? null;
  const providerName = providers.meta?.provider ?? null;
  const pricing = options.pricing ?? providers.pricing;

  const outputDirectory = assertOutputDirectory(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  assertOutputDirectory(outputDirectory);
  const runId = randomUUID();
  const writer = await openRunWriter(outputDirectory, runId);
  const records: RunRecord[] = [];
  let harness: Harness | null = null;
  let aborted = false;
  try {
    const caseFilter = options.cases && options.cases.length ? new Set(options.cases) : null;
    if (caseFilter) {
      const known = new Set(fixtureValue.cases.map(c => c.id));
      for (const id of caseFilter) if (!known.has(id)) throw new Error("case_filter_unknown_id:" + id);
    }
    const selected = caseFilter ? fixtureValue.cases.filter(c => caseFilter.has(c.id)) : fixtureValue.cases.slice(0, 3);
    harness = await buildHarness(fixtureValue);
    const localHarness = harness;
    const timeoutMs = options.timeoutMs ?? 45_000;
    for (const evalCase of selected) {
      if (aborted) break;
      for (const qIndex of variantIndices) {
        const question = evalCase.questions[qIndex];
        const record = await runCase(localHarness, engine, providers.provider, speech, voiceEngine, model, providerName, pricing, evalCase, question, qIndex, timeoutMs);
        record.runIndex = records.length;
        records.push(record);
        await writer.write(record);
        const qualityFailure = record.diagnostics.some(item => ["verification_rejected", "unsupported_claim", "length_exceeded"].includes(item.code))
          && !record.diagnostics.some(item => ["generation_error", "verification_error"].includes(item.code));
        if (record.status === "fail" && record.errorCode !== null && !(options.continueOnFailure && qualityFailure)) { aborted = true; break; }
      }
    }
  } finally {
    try { await writer.close(); } catch { /* keep original error */ }
    if (harness) harness.close();
  }

  const byCategory = new Map<string, RunRecord[]>();
  for (const record of records) {
    const bucket = byCategory.get(record.category) ?? [];
    bucket.push(record);
    byCategory.set(record.category, bucket);
  }

  const summary = {
    version: 1 as const,
    runId,
    label: options.label ?? null,
    provider: providerName,
    model,
    variants,
    variantIndices,
    startedAt,
    finishedAt: new Date().toISOString(),
    fictional: true as const,
    note: "fixture uses fictional documents and fixed fake embeddings; not a retrieval-accuracy benchmark",
    semanticReview: "pending" as const,
    semanticPending: records.length,
    playbackCompleted: null,
    overall: groupStats(records),
    byCategory: Object.fromEntries([...byCategory.entries()].map(([k, v]) => [k, groupStats(v)])),
    unknownUsageCount: records.filter(r => r.usage === "unknown").length
  };

  const summaryPath = join(outputDirectory, runId + "-summary.json");
  const summaryHandle = await open(summaryPath, "wx", 0o600);
  try {
    await summaryHandle.writeFile(JSON.stringify(summary, null, 2), "utf8");
  } finally {
    await summaryHandle.close();
  }

  return { runId, outputDirectory, recordCount: records.length, summaryPath, summary };
}

// ---- CLI ----

type CliArgs = { adapter: string; cases: string[] | null; variants: number; label: string };

function parseCli(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (!args.includes("--allow-api-cost")) throw new Error("cli_cost_acknowledgement_required");
  const map = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { map.set(key, [...(map.get(key) ?? []), next]); i++; }
    else map.set(key, [...(map.get(key) ?? []), "true"]);
  }
  const adapter = map.get("adapter")?.[0];
  if (!adapter) throw new Error("cli_adapter_required");
  const rawCases = map.get("cases")?.[0];
  const cases = rawCases ? rawCases.split(",").map(s => s.trim()).filter(Boolean) : null;
  const variants = Number(map.get("variants")?.[0] ?? "1");
  if (!Number.isInteger(variants) || variants < 1 || variants > 3) throw new Error("cli_variants_out_of_range");
  const label = map.get("label")?.[0] ?? "cli-run";
  return { adapter, cases, variants, label };
}

async function main() {
  const cli = parseCli(process.argv);
  const adapterModule = await import(pathToFileURL(resolve(cli.adapter)).href) as EvaluationAdapter;
  if (typeof adapterModule.createEvaluationProviders !== "function") throw new Error("adapter_must_export_createEvaluationProviders");
  const result = await runGroundedEvaluation({
    adapter: adapterModule,
    cases: cli.cases ?? undefined,
    variants: cli.variants,
    label: cli.label
  });
  process.stdout.write(JSON.stringify({ runId: result.runId, summaryPath: result.summaryPath, recordCount: result.recordCount }) + "\n");
}

const isEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntry) {
  main().catch(error => { process.stderr.write(String((error as Error)?.message ?? error) + "\n"); process.exit(1); });
}
