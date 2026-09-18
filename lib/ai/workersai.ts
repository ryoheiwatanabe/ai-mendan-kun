import type { AiBinding, EmbeddingProvider } from "../types.ts";

// Cloudflare Workers AIの埋め込み。外部APIキーを使わず、Workerのバインディングだけで完結する。
// bge-m3は1024次元なので、既存の1536次元indexへ入れるときはゼロを足して長さを合わせる。
// ゼロ埋めは内積とノルムのどちらにも0を足すだけなので、cosine類似度は変わらない。
export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  private readonly ai: AiBinding;
  readonly model: string;
  readonly dimensions: number;
  constructor(ai: AiBinding, model = "@cf/baai/bge-m3", dimensions = 1536) {
    this.ai = ai; this.model = model; this.dimensions = dimensions;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    const result = await this.ai.run(this.model, { text: [text] }) as { data?: number[][] } | null;
    signal?.throwIfAborted();
    const vector = result?.data?.[0];
    if (!Array.isArray(vector) || !vector.length || vector.some(value => typeof value !== "number" || !Number.isFinite(value))
      || vector.length > this.dimensions) throw new Error("invalid_embedding");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid_embedding");
    const normalized = vector.map(value => value / norm);
    // モデルの次元がindexより小さい場合は、意味を持たない0で埋めて長さだけ合わせる。
    return normalized.length === this.dimensions ? normalized
      : [...normalized, ...new Array(this.dimensions - normalized.length).fill(0)];
  }
}
