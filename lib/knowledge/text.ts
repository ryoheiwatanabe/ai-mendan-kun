export function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

// 日本語は空白に依存しない文字bigram、英数は単語。同じ処理を投入と検索に使用する。
export function searchTerms(text: string): string[] {
  const input = normalize(text).toLowerCase();
  const terms: string[] = input.match(/[a-z0-9][a-z0-9_+-]*/g) ?? [];
  for (const match of input.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu)) {
    const chars = Array.from(match[0]);
    if (chars.length === 1) terms.push(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(terms)];
}

export function ftsQuery(text: string): string {
  return searchTerms(text).slice(0, 72).map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchQuery(question: string, history: { role: string; content: string }[]): string {
  if (!/(その|それ|当時|そこで|もう少し|詳しく|ほかには|他には|具体的|現在|今は|その後)/.test(question)) return question;
  const previousUser = history.filter(turn => turn.role === "user").slice(-2).map(turn => turn.content).join("\n");
  return `${previousUser}\n${question}`.slice(-4000);
}

export function sentences(text: string): string[] {
  return normalize(text).split(/(?<=[。！？!?])\s*|\n+/u).map(value => value.trim()).filter(Boolean);
}

export function chunkMarkdown(text: string): { title: string; content: string }[] {
  const output: { title: string; content: string }[] = [];
  let title = "プロフィール";
  let buffer = "";
  const flush = () => { if (buffer.trim()) output.push({ title, content: buffer.trim() }); buffer = ""; };
  for (const part of normalize(text).split(/\n\s*\n|(?=^#{1,6}\s)/m)) {
    let unit = part.trim();
    if (/^#{1,6}\s/.test(unit)) {
      flush();
      const [heading, ...rest] = unit.split("\n");
      title = heading.replace(/^#{1,6}\s+/, ""); unit = rest.join("\n").trim();
    }
    if (!unit) continue;
    if (unit.length > 800) throw new Error("一つの段落は800文字以内にしてください。但し書きは同じ段落に残してください。");
    if (buffer.length + unit.length > 1800) flush();
    buffer += (buffer ? "\n\n" : "") + unit;
  }
  flush();
  return output;
}

export function approvedUnits(content: string): string[] {
  return normalize(content).split(/\n\s*\n|\n(?=#{1,6}\s)/).map(unit => unit.replace(/^#{1,6}[^\n]*(?:\n|$)/, "").trim()).filter(Boolean);
}

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
