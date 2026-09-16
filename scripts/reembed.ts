import { adminRequest, reportError } from "./import-file.ts";
// 埋め込みモデルの切替時に、承認済みの現行版を現在の設定で作り直す。本文と承認状態は変えない。
try {
  console.log(JSON.stringify(await adminRequest({ action: "reembed" }), null, 2));
} catch (error) { reportError(error); }
