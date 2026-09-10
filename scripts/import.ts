import { readImport, adminRequest, reportError } from "./import-file.ts";
try {
  const [path, option, approvalHash] = process.argv.slice(2);
  if (!path || (option && option !== "--approve-hash") || (option && !approvalHash)) throw new Error("使用方法: npm run knowledge:import -- <manifest.json> [--approve-hash <確認済みハッシュ>]");
  const prepared = await readImport(path);
  if (approvalHash && approvalHash !== prepared.hash) throw new Error("本文または登録内容が変わっています。レビューを再生成してください。");
  console.log(JSON.stringify(await adminRequest({ action: approvalHash ? "approve" : "stage", bundle: prepared.bundle, hash: approvalHash }), null, 2));
} catch (error) { reportError(error); }
