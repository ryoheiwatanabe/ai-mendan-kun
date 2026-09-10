import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "127.0.0.1", "--port", "8787"], {
  stdio: "inherit", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }
});
child.on("exit", code => process.exit(code ?? 1));
