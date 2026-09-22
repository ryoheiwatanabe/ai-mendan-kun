import type { Database } from "../types.ts";
import { jevQuestionIds } from "../ai/jev.ts";
import { jevScopeNoulIds } from "../ai/jev-scope.ts";
import { parseJevSettings, type JevSettings } from "./jev-settings.ts";

// 保存済みの版。壊れた保存値は settings=null とし、回答では既定へ戻す。
export type JevSettingsRecord = { version: number; createdAt: string; settings: JevSettings | null; invalid: boolean };
export type JevSettingsState = { current: JevSettingsRecord | null; previous: JevSettingsRecord | null };
// 実行時の採点の控え。採点の値だけで、質問・回答・根拠の本文は持たない。
export type JevScoreSample = { createdAt: string; settingsVersion: number | null; kind: "answer" | "scope"; scores: Record<string, number> };

// 控えは直近の数件だけ残す。管理画面で採否例を見るために使う。
const sampleLimit = 10;

export class JevSettingsStore {
  readonly db: Database;
  readonly ownerId: string;
  constructor(db: Database, ownerId: string) { this.db = db; this.ownerId = ownerId; }

  // 直近2版を読む。現在値と、戻す先（直前の版）を返す。
  async state(): Promise<JevSettingsState> {
    const rows = await this.db.prepare(`SELECT version,created_at,settings_json FROM jev_settings_versions
      WHERE owner_id=? ORDER BY version DESC LIMIT 2`).bind(this.ownerId)
      .all<{ version: number; created_at: string; settings_json: string }>();
    const [current, previous] = rows.results.map(toRecord);
    return { current: current ?? null, previous: previous ?? null };
  }

  async latestVersion(): Promise<number | null> {
    const row = await this.db.prepare(`SELECT MAX(version) AS version FROM jev_settings_versions WHERE owner_id=?`)
      .bind(this.ownerId).first<{ version: number | null }>();
    return row?.version === null || row?.version === undefined ? null : Number(row.version);
  }

  async save(settings: JevSettings): Promise<number> {
    const version = (await this.latestVersion() ?? 0) + 1;
    await this.db.prepare(`INSERT INTO jev_settings_versions(owner_id,version,created_at,settings_json) VALUES(?,?,?,?)`)
      .bind(this.ownerId, version, new Date().toISOString(), JSON.stringify(settings)).run();
    return version;
  }

  // 直前の版を新しい版として書き戻す。過去の版は消さない。
  async revertPrevious(): Promise<number> {
    const previous = (await this.state()).previous;
    if (!previous?.settings) throw new Error("no_previous_jev_settings");
    return this.save(previous.settings);
  }
}

function toRecord(row: { version: number; created_at: string; settings_json: string }): JevSettingsRecord {
  try { return { version: Number(row.version), createdAt: row.created_at, settings: parseJevSettings(JSON.parse(row.settings_json)), invalid: false }; }
  catch { return { version: Number(row.version), createdAt: row.created_at, settings: null, invalid: true }; }
}

// スコアの控えを1件足し、古いものを落とす。失敗しても回答は止めない。
export async function recordScoreSample(db: Database, ownerId: string, sample: JevScoreSample): Promise<void> {
  const axes = sample.kind === "scope" ? jevScopeNoulIds : jevQuestionIds;
  const kept: Record<string, number> = {};
  for (const axis of axes) {
    const score = sample.scores[axis];
    if (sample.kind === "scope" && !Object.hasOwn(sample.scores, axis)) continue;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return;
    kept[axis] = score;
  }
  // 選別の判定枠に入らなかった軸は、0点で補わず未評価のまま記録する。
  if (!Object.keys(kept).length) return;
  await db.prepare(`INSERT INTO jev_score_samples(owner_id,created_at,settings_version,kind,scores_json)
    VALUES(?,?,?,?,?)`).bind(ownerId, sample.createdAt, sample.settingsVersion, sample.kind, JSON.stringify(kept)).run();
  await db.prepare(`DELETE FROM jev_score_samples WHERE owner_id=? AND id NOT IN
    (SELECT id FROM jev_score_samples WHERE owner_id=? ORDER BY id DESC LIMIT ?)`).bind(ownerId, ownerId, sampleLimit).run();
}

export async function scoreSamples(db: Database, ownerId: string): Promise<JevScoreSample[]> {
  const rows = await db.prepare(`SELECT created_at,settings_version,kind,scores_json FROM jev_score_samples
    WHERE owner_id=? ORDER BY id DESC LIMIT ?`).bind(ownerId, sampleLimit)
    .all<{ created_at: string; settings_version: number | null; kind: string; scores_json: string }>();
  return rows.results.flatMap(row => {
    try {
      const scores = JSON.parse(row.scores_json) as Record<string, unknown>;
      const axes = row.kind === "scope" ? jevScopeNoulIds : jevQuestionIds;
      const kept: Record<string, number> = {};
      for (const axis of axes) {
        const score = scores[axis];
        if (row.kind === "scope" && !Object.hasOwn(scores, axis)) continue;
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return [];
        kept[axis] = score;
      }
      if (!Object.keys(kept).length) return [];
      return [{ createdAt: row.created_at, settingsVersion: row.settings_version === null ? null : Number(row.settings_version),
        kind: row.kind === "scope" ? "scope" as const : "answer" as const, scores: kept }];
    } catch { return []; }
  });
}

// 段階ごとの所要時間。日本からの実測（p50/p95）と修復率の確認に使う。
export type JevStageMetric = { stage: string; count: number; p50: number; p95: number };
// 段階のほかに、絞り込みとバックエンド比較（probe）の実測も同じ表に残す。
const timingStages = ["scope", "generation", "judge", "repair", "screening", "probe-official", "probe-workers-ai"] as const;
const timingLimit = 200;

export async function recordStageTiming(db: Database, ownerId: string, stage: typeof timingStages[number], ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) return;
  await db.prepare(`INSERT INTO jev_stage_timings(owner_id,created_at,stage,ms) VALUES(?,?,?,?)`)
    .bind(ownerId, new Date().toISOString(), stage, Math.round(ms)).run();
  await db.prepare(`DELETE FROM jev_stage_timings WHERE owner_id=? AND id NOT IN
    (SELECT id FROM jev_stage_timings WHERE owner_id=? ORDER BY id DESC LIMIT ?)`).bind(ownerId, ownerId, timingLimit * timingStages.length).run();
}

export async function stageMetrics(db: Database, ownerId: string): Promise<JevStageMetric[]> {
  const rows = await db.prepare(`SELECT stage,ms FROM jev_stage_timings WHERE owner_id=? ORDER BY id DESC LIMIT ?`)
    .bind(ownerId, timingLimit * timingStages.length).all<{ stage: string; ms: number }>();
  return timingStages.flatMap(stage => {
    const values = rows.results.filter(row => row.stage === stage).map(row => Number(row.ms)).sort((left, right) => left - right);
    if (!values.length) return [];
    return [{ stage, count: values.length, p50: percentile(values, .5), p95: percentile(values, .95) }];
  });
}

function percentile(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

// 回答で使う設定を決める。保存値が無い・壊れている場合は既定を使い、理由を固定識別子で返す。
export async function resolveJevSettings(store: JevSettingsStore, defaults: JevSettings):
  Promise<{ settings: JevSettings; version: number | null; fallback?: "stored_settings_invalid" }> {
  const { current } = await store.state();
  if (!current) return { settings: defaults, version: null };
  if (!current.settings) return { settings: defaults, version: current.version, fallback: "stored_settings_invalid" };
  return { settings: current.settings, version: current.version };
}
