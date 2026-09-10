import { spawn } from "node:child_process";
// envファイルを使わず、Wranglerにも読み込ませない。秘密値はこのスクリプトで扱わない。
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
  stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" }
});
child.on("exit", code => process.exit(code ?? 1));
