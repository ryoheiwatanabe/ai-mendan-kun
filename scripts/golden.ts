import { readFile } from "node:fs/promises";
import { readSse } from "../lib/ai/sse.ts";
import type { Answerability, ChatEvent, Turn } from "../lib/types.ts";

type Case = { id: string; question: string; history?: Turn[]; follows?: string; expectedFacts?: string[];
  forbiddenClaims?: string[]; expectedAnswerability: Answerability[]; maxLatencyMs?: number };

try {
  const [file, base, permission] = process.argv.slice(2);
  if (!file || !base || permission !== "--allow-api-cost") throw new Error("使用方法: npm run golden -- <本人確認済みcases.json> <URL> --allow-api-cost\n実APIを質問数分呼び出します。費用と送信内容を確認してから実行してください。");
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("HTTPSまたはlocalhostを指定してください。");
  const config = JSON.parse(await readFile(file, "utf8")) as { approvedForEvaluation: boolean; cases: Case[] };
  if (config.approvedForEvaluation !== true || !Array.isArray(config.cases) || config.cases.length < 10 || config.cases.length > 20) throw new Error("本人確認済みの10〜20問を指定してください。テンプレートは直接実行できません。");
  if (new Set(config.cases.map(item => item.id)).size !== config.cases.length) throw new Error("Case IDが重複しています。");
  const completed = new Map<string, { question: string; answer: string }>();
  const results = [];
  for (const item of config.cases) {
    if (!item.question || !item.expectedAnswerability?.length) throw new Error("質問と期待する回答可否が必要です。");
    const previous = item.follows ? completed.get(item.follows) : null;
    if (item.follows && !previous) throw new Error("続きの質問の参照先がまだ完了していません。");
    const history: Turn[] = previous ? [{ role: "user", content: previous.question }, { role: "assistant", content: previous.answer }] : item.history ?? [];
    const response = await fetch(new URL("/api/chat", url), { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({ mode: "meeting_text", message: item.question, history }), signal: AbortSignal.timeout(50_000) });
    if (!response.ok || !response.body) throw new Error(`Case ${item.id}: HTTP ${response.status}。追加の課金を避けるため停止しました。`);
    let text = "";
    let final: Extract<ChatEvent, { type: "done" }> | undefined;
    for await (const raw of readSse(response.body)) {
      const event = JSON.parse(raw) as ChatEvent;
      if (event.type === "error") throw new Error(`Case ${item.id}: 回答エラー。評価を停止しました。`);
      if (event.type === "text") text += event.text;
      if (event.type === "done") final = event;
    }
    const failures = [];
    if (!final) failures.push("incomplete");
    else if (!item.expectedAnswerability.includes(final.answerability)) failures.push("answerability");
    if (item.expectedFacts?.some(fact => !text.includes(fact))) failures.push("missing_expected_fact");
    if (item.forbiddenClaims?.some(claim => text.includes(claim))) failures.push("forbidden_claim");
    if (item.maxLatencyMs && final && final.latencyMs > item.maxLatencyMs) failures.push("latency");
    completed.set(item.id, { question: item.question, answer: text });
    // ローカルにも質問・回答本文を出力/保存せず、判定と計測値だけを返す。
    const result = { id: item.id, pass: failures.length === 0, failures, answerability: final?.answerability, latencyMs: final?.latencyMs, firstTextMs: final?.firstTextMs };
    results.push(result); console.log(JSON.stringify(result));
  }
  const passed = results.filter(item => item.pass).length;
  console.log(JSON.stringify({ passed, total: results.length, requiresOwnerReview: true }));
  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "評価を実行できませんでした。");
  process.exitCode = 1;
}
