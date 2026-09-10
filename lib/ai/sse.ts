// ネットワーク境界で分断されたUTF-8とSSEフレームを復元する。
export async function* readSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
      if (pending.length > 150_000) throw new Error("stream_frame_too_large");
      if (next.done) break;
    }
    if (pending.trim()) throw new Error("incomplete_stream_frame");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// 配列中の閉じたオブジェクトだけを取り出す。部分文字列を利用者へ表示しない。
export function completedSegments(json: string): unknown[] {
  const match = /"segments"\s*:\s*\[/.exec(json);
  if (!match) return [];
  const output: unknown[] = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") { if (depth === 0) start = i; depth++; }
    if (char === "}" || char === "]") {
      if (depth === 0) return output;
      depth--;
      if (depth === 0) output.push(JSON.parse(json.slice(start, i + 1)));
    }
  }
  return output;
}
