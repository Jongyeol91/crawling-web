import { defineConfig } from "playwright/test";

export default defineConfig({
  timeout: 60_000,
  use: {
    baseURL: "https://spc.esongpa.or.kr",
    // Mimic real user browser to avoid detection
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    // Storage state for session persistence
    storageState: "storage-state.json",
    // Stealth settings
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  },
});
