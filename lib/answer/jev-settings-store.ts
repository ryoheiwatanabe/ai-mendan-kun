import type { Database } from "../types.ts";
import { parseJevSettings, type JevSettings } from "./jev-settings.ts";

// 保存済みの版。壊れた保存値は settings=null とし、回答では既定へ戻す。
export type JevSettingsRecord = { version: number; createdAt: string; settings: JevSettings | null; invalid: boolean };
export type JevSettingsState = { current: JevSettingsRecord | null; previous: JevSettingsRecord | null };

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

// 回答で使う設定を決める。保存値が無い・壊れている場合は既定を使い、理由を固定識別子で返す。
export async function resolveJevSettings(store: JevSettingsStore, defaults: JevSettings):
  Promise<{ settings: JevSettings; version: number | null; fallback?: "stored_settings_invalid" }> {
  const { current } = await store.state();
  if (!current) return { settings: defaults, version: null };
  if (!current.settings) return { settings: defaults, version: current.version, fallback: "stored_settings_invalid" };
  return { settings: current.settings, version: current.version };
}
