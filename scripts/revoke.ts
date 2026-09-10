import { adminRequest, reportError } from "./import-file.ts";
try {
  const revisionId = process.argv[2];
  if (!revisionId || !/^rev_[a-f0-9]{32}$/.test(revisionId)) throw new Error("使用方法: npm run knowledge:revoke -- <rev_ID>");
  console.log(JSON.stringify(await adminRequest({ action: "revoke", revisionId }), null, 2));
} catch (error) { reportError(error); }
