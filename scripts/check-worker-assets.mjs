// ビルド済みWorkerを、本番と同じworker-firstの配信設定で確認する。
// 外部AI・実DB・運用設定・Secretは使わない。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, ".local"), { recursive: true });
const directory = await mkdtemp(join(root, ".local", "worker-assets-"));
const token = "synthetic-preview-key-for-local-asset-regression";
const port = 8795;
const origin = `http://127.0.0.1:${port}`;
let child;

async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
}

try {
  for (const protectedPreview of [false, true]) {
    const config = join(directory, "wrangler.jsonc");
    await writeFile(config, JSON.stringify({
      name: "local-worker-assets-check", main: join(root, "worker.ts"),
      compatibility_date: "2026-09-09", compatibility_flags: ["nodejs_compat"],
      assets: { directory: join(root, ".open-next/assets"), binding: "ASSETS", run_worker_first: true },
      vars: { PREVIEW_ONLY: String(protectedPreview), ...(protectedPreview ? { PREVIEW_ACCESS_TOKEN: token } : {}) }
    }));
    let output = "";
    child = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port),
      "--persist-to", join(directory, "state"), "--log-level", "error"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-8000); });
    let ready = false;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (child.exitCode !== null) throw new Error(`worker_start_failed: ${output}`);
      try { const response = await fetch(`${origin}/api/health`); await response.body?.cancel(); ready = true; break; }
      catch { await new Promise(done => setTimeout(done, 150)); }
    }
    assert.ok(ready, `worker_start_timeout: ${output}`);
    const headers = protectedPreview ? { Authorization: `Basic ${Buffer.from(`test:${token}`).toString("base64")}` } : {};
    const rootResponse = await fetch(origin, { headers });
    assert.equal(rootResponse.status, 200, "HTML must load");
    const html = await rootResponse.text();
    const assets = [...new Set([...html.matchAll(/(?:href|src)="([^"?#]+\.(?:css|js))"/g)].map(match => match[1]))];
    assert.ok(assets.some(path => path.endsWith(".css")), "HTML must reference CSS");
    assert.ok(assets.some(path => path.endsWith(".js")), "HTML must reference JavaScript");
    for (const path of assets) {
      assert.ok(path.startsWith("/_next/static/"), "Only bundled local assets are requested");
      const response = await fetch(new URL(path, origin), { headers });
      assert.equal(response.status, 200, `${protectedPreview ? "preview" : "public"}: ${path}`);
      assert.match(response.headers.get("content-type") ?? "", path.endsWith(".css") ? /text\/css/ : /javascript/);
      assert.ok((await response.text()).length > 0);
    }
    const head = await fetch(new URL(assets[0], origin), { method: "HEAD", headers });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    const health = await fetch(`${origin}/api/health`, { headers });
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: "ok" });
    for (const path of ["/voice", "/admin"]) {
      const page = await fetch(new URL(path, origin), { headers });
      assert.equal(page.status, 200, `Next page must remain reachable: ${path}`);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/); await page.body?.cancel();
    }
    const post = await fetch(`${origin}/api/health`, { method: "POST", headers });
    assert.equal(post.status, 405); await post.body?.cancel();
    const missing = await fetch(`${origin}/_next/static/missing-regression.css`, { headers });
    assert.equal(missing.status, 404); await missing.body?.cancel();
    if (protectedPreview) {
      for (const path of ["/", assets[0], "/api/health"]) {
        const denied = await fetch(new URL(path, origin));
        assert.equal(denied.status, 401, `Preview must protect ${path}`);
        assert.match(denied.headers.get("www-authenticate") ?? "", /^Basic /);
        assert.equal(await denied.text(), "Protected preview");
      }
    }
    console.log(`${protectedPreview ? "protected preview" : "public"}: HTML, ${assets.length} assets, HEAD, API and missing asset passed`);
    await stop();
  }
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
