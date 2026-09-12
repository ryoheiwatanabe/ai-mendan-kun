import { defineConfig } from "@playwright/test";
const port = process.env.MENDAN_DEV_PORT ?? "3000";
if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
  throw new Error("MENDAN_DEV_PORT は 1〜65535 の整数で指定してください。");
}
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/browser", fullyParallel: false, reporter: "list", timeout: 30_000,
  use: { baseURL, channel: "chrome", trace: "off", screenshot: "only-on-failure" },
  webServer: { command: "npm run dev", url: baseURL, reuseExistingServer: true, timeout: 90_000 }
});
