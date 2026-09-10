import type { Database } from "../types.ts";
import { sha256 } from "../knowledge/text.ts";
import { PublicError } from "./request.ts";

export async function enforceLimits(db: Database, input: { ip: string; secret: string; ownerId: string; daily: number; hourly: number; now?: number }) {
  const now = input.now ?? Date.now();
  // 日ごとに変わる匿名キー。生IPも本文も保存しない。
  const day = Math.floor(now / 86_400_000);
  const hour = Math.floor(now / 3_600_000);
  const ipHash = await sha256(`${input.secret}:ratelimit:${day}:${input.ip}`);
  const buckets = [
    { key: `${input.ownerId}:ip:${hour}:${ipHash}`, max: input.hourly, expiry: now + 7_200_000 },
    { key: `${input.ownerId}:daily:${day}`, max: input.daily, expiry: (day + 2) * 86_400_000 }
  ];
  // 条件付きUPSERTで並行リクエスト時も上限以上のLLM呼び出しを許可しない。
  const result = await db.batch<{ count: number }>(buckets.map((bucket, index) => db.prepare(`
    INSERT INTO request_counters(bucket,count,expires_at) SELECT ?,1,? WHERE ${index === 0 ? "1" : "changes()>0"}
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`)
    .bind(bucket.key, bucket.expiry, bucket.max)));
  await db.prepare("DELETE FROM request_counters WHERE expires_at < ?").bind(now).run();
  if (result.some(row => row.results.length !== 1)) throw new PublicError("RATE_LIMITED", 429, "しばらく時間をおいてから、もう一度お試しください。");
}
