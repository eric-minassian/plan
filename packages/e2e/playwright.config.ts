import { defineConfig, devices } from "@playwright/test";
import { loadE2EEnv } from "./src/env.js";

const env = loadE2EEnv();

/**
 * Playwright config for critical-path e2e against a real host
 * (staging/prod dogfood or CloudFront dev URL).
 *
 * Secrets-driven: tests self-skip when credentials are absent so CI stays green
 * without E2E secrets configured.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: env.baseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    // Share exchange relies on first-party cookies (credentials: include).
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
