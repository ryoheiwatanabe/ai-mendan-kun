// 秘密値の照合。長さと全文字を比べ、一致の位置で時間が変わらないようにする。
export function constantTimeEqual(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
