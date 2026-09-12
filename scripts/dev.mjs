import { spawn } from "node:child_process";
const port = process.env.MENDAN_DEV_PORT ?? "3000";
if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
  throw new Error("MENDAN_DEV_PORT は 1〜65535 の整数で指定してください。");
}
// envファイルを使わず、Wranglerにも読み込ませない。秘密値はこのスクリプトで扱わない。
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", port], {
  stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" }
});
child.on("exit", code => process.exit(code ?? 1));
