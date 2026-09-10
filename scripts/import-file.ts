import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { prepareImport } from "../lib/knowledge/import.ts";

export async function readImport(path: string) {
  const input = JSON.parse(await readFile(path, "utf8"));
  if (input.contentFile) {
    if (input.content) throw new Error("contentとcontentFileはどちらか一方にしてください。");
    const file = resolve(dirname(resolve(path)), input.contentFile);
    if (!file.endsWith(".md")) throw new Error("contentFileはMarkdownを指定してください。");
    input.content = await readFile(file, "utf8");
    delete input.contentFile;
  }
  return prepareImport(input);
}

export async function adminRequest(value: unknown) {
  const response = await fetch("http://127.0.0.1:8790", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(150_000) });
  const result = await response.json() as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(result.error || "管理処理に失敗しました。");
  return result.result;
}

export function reportError(error: unknown): never {
  console.error(error instanceof Error && !/fetch failed|ECONNREFUSED/.test(error.message) ? error.message : "管理ブリッジに接続できません。npm run admin:devとCloudflareログインを確認してください。");
  process.exit(1);
}
