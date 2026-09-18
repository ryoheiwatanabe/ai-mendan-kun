import { getAdminBindings } from "../../../../lib/runtime.ts";
import { adminAllowed } from "../../../../lib/security/admin.ts";
import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { adminErrorCode } from "../../../../lib/security/admin-error.ts";
import { TypeSafeJev, type JevJudge } from "../../../../lib/ai/jev.ts";
import { WorkersAiJev } from "../../../../lib/ai/jev-workers-ai.ts";
import { recordStageTiming } from "../../../../lib/answer/jev-settings-store.ts";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };

// 架空の資料だけを使い、両バックエンドへ同じstate/questionsを送って時間と応答の形を比べる。
// 本人の資料・会話・Secretは送らない。返すのも時間と固定コードだけにする。
const probeEvidence = [
  { id: "rev_probe:0", kind: "chunk" as const, title: "架空の経歴", revisionId: "rev_probe", documentId: "probe", ownerId: "probe",
    text: "2019年から2023年まで、架空の会社で問い合わせ対応を担当しました。",
    content: "2019年から2023年まで、架空の会社で問い合わせ対応を担当しました。", facts: [], entities: [] },
  { id: "rev_probe:1", kind: "chunk" as const, title: "架空の趣味", revisionId: "rev_probe", documentId: "probe", ownerId: "probe",
    text: "子供のころは図書館で過ごすことが多かったです。",
    content: "子供のころは図書館で過ごすことが多かったです。", facts: [], entities: [] }
];
const probeQuestion = "問い合わせ対応では何を担当しましたか？";

type ProbeRun = { ok: boolean; ms: number; code?: string; types?: string[]; judgments?: number;
  confidence?: number; inputTokens?: number; outputTokens?: number; errorName?: string; errorDetail?: string };

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getAdminBindings();
    if (!adminAllowed(request, env)) return Response.json({ error: { code: "ADMIN_REQUIRED", message: "管理用の鍵を確認できませんでした。" } }, { status: 403, headers });
    const body = await request.text();
    let runs = 3, debug = false;
    if (body.trim()) {
      if (!request.headers.get("content-type")?.includes("application/json")) throw new PublicError("INVALID_INPUT", 400, "要求を読み取れませんでした。");
      const input = JSON.parse(body) as { runs?: unknown; debug?: unknown };
      if (input.runs !== undefined && (typeof input.runs !== "number" || !Number.isInteger(input.runs) || input.runs < 1 || input.runs > 5))
        throw new PublicError("INVALID_INPUT", 400, "回数は1〜5の整数で指定してください。");
      runs = (input.runs as number | undefined) ?? runs;
      // 管理者が原因を切り分けるための任意の詳細。架空の資料しか送っていない。
      debug = input.debug === true;
    }
    const judges: { stage: "probe-official" | "probe-workers-ai"; judge: JevJudge }[] = [
      { stage: "probe-official", judge: new TypeSafeJev(env.TYPESAFE_API_KEY ?? "", 15_000) }
    ];
    if (env.AI) judges.push({ stage: "probe-workers-ai", judge: new WorkersAiJev(env.AI) });
    const results: Record<string, ProbeRun[]> = {};
    for (const { stage, judge } of judges) {
      const list: ProbeRun[] = [];
      for (let run = 0; run < runs; run++) {
        const started = performance.now();
        try {
          const assessment = await judge.checkScope!({ question: probeQuestion, history: [], evidence: probeEvidence as never, maxJudgments: 10 }, AbortSignal.timeout(20_000));
          const ms = Math.round(performance.now() - started);
          const answers = Object.values(assessment.answers);
          const confidences = answers.flatMap(answer => (answer.type === "choice" || answer.type === "score") && typeof answer.confidence === "number" ? [answer.confidence] : []);
          list.push({ ok: true, ms, types: [...new Set(answers.map(answer => answer.type))].sort(), judgments: assessment.asked.length,
            ...(confidences.length ? { confidence: Number(Math.min(...confidences).toFixed(3)) } : {}),
            ...(assessment.usage ? { inputTokens: assessment.usage.input, outputTokens: assessment.usage.output } : {}) });
          await recordStageTiming(env.DB, env.OWNER_ID || "default", stage, ms);
        } catch (error) {
          list.push({ ok: false, ms: Math.round(performance.now() - started), code: probeCode(error),
            ...(debug && error instanceof Error ? { errorName: error.name, errorDetail: error.message.slice(0, 200) } : {}) });
        }
      }
      results[stage] = list;
    }
    return Response.json({ runs, results,
      note: "架空の資料だけを送っています。時間と固定コードだけで、本文は返しません。" }, { headers });
  } catch (error) {
    const known = error instanceof PublicError;
    return Response.json({ error: { code: known ? error.code : "PROBE_UNAVAILABLE",
      message: known ? error.message : "比較を実行できませんでした。時間をおいてお試しください。" } },
      { status: known ? error.status : 503, headers });
  }
}

// 失敗の理由を固定コードへ写す。プロバイダの自由文は返さない。
function probeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (/invalid_jev/.test(message)) return "invalid_response";
  if (/model|no such/i.test(message)) return "model_not_found";
  if (/permission|not authorized|forbidden|unauthor|not enabled|not available/i.test(message)) return "not_authorized";
  if (/schema|invalid|unexpected|unsupported/i.test(message)) return "invalid_request";
  return adminErrorCode(error);
}
