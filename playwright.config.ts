import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser", fullyParallel: false, reporter: "list", timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3000", channel: "chrome", trace: "off", screenshot: "only-on-failure" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:3000", reuseExistingServer: true, timeout: 90_000 }
});
