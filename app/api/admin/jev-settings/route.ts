import { getAdminBindings } from "../../../../lib/runtime.ts";
import { adminAllowed } from "../../../../lib/security/admin.ts";
import { checkOrigin, PublicError } from "../../../../lib/security/request.ts";
import { defaultJevSettings, jevCeilings, parseJevSettings } from "../../../../lib/answer/jev-settings.ts";
import { JevSettingsStore, scoreSamples, stageMetrics } from "../../../../lib/answer/jev-settings-store.ts";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 8_000;
// 保存前の拒否理由は固定の日本語へ写す。範囲外の値を黙って丸めない。
const messages: Record<string, string> = {
  invalid_jev_settings_shape: "設定の形を読み取れませんでした。画面を読み直してから、もう一度お試しください。",
  invalid_jev_axis: "評価項目の指定を確認してください。",
  invalid_jev_threshold: "閾値は0〜1の数値で入力してください。",
  invalid_jev_treatment: "各項目の扱いは「必須」「任意」「記録のみ」から選んでください。",
  invalid_jev_optional_limit: "任意項目の不合格件数を確認してください。",
  invalid_jev_limits: `段階数は1〜${jevCeilings.maxSerialStages}、段階内の判定数は1〜${jevCeilings.maxJudgmentsPerStage}、修復は0〜${jevCeilings.maxRepairs}の整数です。`,
  invalid_jev_judgments_required: "判定数が必須の項目数より少なく設定できません。必須を減らすか、判定数を増やしてください。",
  invalid_jev_budgets: "時間予算を確認してください。",
  invalid_jev_scope: "生成前の選別の設定を確認してください。",
  invalid_jev_scope_threshold: "生成前の選別の閾値は0〜1の数値で入力してください。",
  invalid_jev_confidence: "確信度の閾値は0〜1の数値で入力してください。",
  invalid_jev_low_confidence_action: "低確信のときの行き先を選んでください。",
  no_previous_jev_settings: "戻せる直前の設定がありません。"
};

function denied(): Response {
  return Response.json({ error: { code: "ADMIN_REQUIRED", message: "管理用の鍵を確認できませんでした。鍵を入力し直してください。" } }, { status: 403, headers });
}

function failure(error: unknown, fallback: string, status: number): Response {
  const known = error instanceof PublicError;
  return Response.json({ error: { code: known ? error.code : "ADMIN_UNAVAILABLE", message: known ? error.message : fallback } },
    { status: known ? error.status : status, headers });
}

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const env = await getAdminBindings();
    if (!adminAllowed(request, env)) return denied();
    const ownerId = env.OWNER_ID || "default";
    const { current, previous } = await new JevSettingsStore(env.DB, ownerId).state();
    // 実行時の採点の控え（本文なし）。現在の設定を当てた採否例を画面で確認するために返す。
    const samples = await scoreSamples(env.DB, ownerId).catch(() => []);
    const metrics = await stageMetrics(env.DB, ownerId).catch(() => []);
    return Response.json({ current, previous, samples, metrics, defaults: defaultJevSettings(env), ceilings: jevCeilings,
      ...(current?.invalid ? { note: "stored_settings_invalid" } : {}) }, { headers });
  } catch (error) {
    return failure(error, "設定を読み込めませんでした。時間をおいてお試しください。", 503);
  }
}

export async function POST(request: Request) {
  let action = "", code = "";
  try {
    checkOrigin(request);
    const env = await getAdminBindings();
    if (!adminAllowed(request, env)) return denied();
    if (!request.headers.get("content-type")?.includes("application/json")) throw new PublicError("INVALID_INPUT", 400, "設定を読み取れませんでした。画面を読み直してください。");
    const body = await request.text();
    if (body.length > MAX_BODY) throw new PublicError("INVALID_INPUT", 413, "設定が大きすぎます。項目を減らしてください。");
    let input: { action?: unknown; settings?: unknown };
    try { input = JSON.parse(body) as { action?: unknown; settings?: unknown }; }
    catch { throw new PublicError("INVALID_INPUT", 400, "設定を読み取れませんでした。画面を読み直してください。"); }
    action = typeof input.action === "string" ? input.action : "";
    const ownerId = env.OWNER_ID || "default";
    const store = new JevSettingsStore(env.DB, ownerId);
    if (action === "save" || action === "resetDefaults") {
      // 保存前に範囲を検査し、実装の上限を超える値は受け取らない。
      const settings = action === "save" ? parseJevSettings(input.settings) : defaultJevSettings(env);
      await store.save(settings);
    } else if (action === "revertPrevious") {
      await store.revertPrevious();
    } else {
      throw new PublicError("INVALID_INPUT", 400, "操作を確認してください。");
    }
    const { current, previous } = await store.state();
    return Response.json({ current, previous, samples: await scoreSamples(env.DB, ownerId).catch(() => []),
      metrics: await stageMetrics(env.DB, ownerId).catch(() => []),
      defaults: defaultJevSettings(env), ceilings: jevCeilings }, { headers });
  } catch (error) {
    if (error instanceof PublicError) return failure(error, "設定を保存できませんでした。", 400);
    code = error instanceof Error ? error.message : "";
    if (messages[code]) return Response.json({ error: { code, message: messages[code] } }, { status: 400, headers });
    return failure(error, "設定を保存できませんでした。時間をおいてお試しください。", 503);
  }
}
