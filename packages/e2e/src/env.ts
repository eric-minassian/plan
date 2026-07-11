/**
 * Environment for Playwright share smoke.
 *
 * Prefer a pre-seeded capability token (`E2E_SHARE_TOKEN`) so CI does not need
 * passkeys. Optionally seed via owner Bearer JWT (`E2E_OWNER_ACCESS_TOKEN`).
 *
 * Local `.env` is loaded optionally (does not override already-exported vars).
 * Playwright does not load dotenv by itself — see `loadLocalEnvFile`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_E2E_BASE_URL =
  "https://plan-staging.ericminassian.com" as const;

export interface E2EEnv {
  /** Public plan host (SPA + /api). HTTPS required for Secure share cookies. */
  readonly baseUrl: string;
  /**
   * Pre-created raw share token (hash-fragment secret).
   * When set, smoke opens `/s#token` without owner auth.
   */
  readonly shareToken: string | undefined;
  /** Expected trip title when using `shareToken` (asserted in the UI). */
  readonly shareTripTitle: string | undefined;
  /**
   * Owner access token (Bearer). When set and `shareToken` is absent, the
   * suite seeds a trip + share grant via the public API before the browser test.
   * Prefer a non-DPoP-bound token (DPoP-bound tokens cannot be downgraded).
   */
  readonly ownerAccessToken: string | undefined;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

/**
 * Minimal KEY=VALUE loader for local runs.
 * - Does not override variables already present in `process.env`
 * - Ignores blank lines and `#` comments
 * - Never required: missing file is a no-op
 */
export function loadLocalEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(filePath)) {
    return;
  }
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    const existing = env[key];
    if (existing !== undefined && existing.length > 0) {
      continue;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

/** Resolve `packages/e2e/.env` relative to this module (works under Playwright). */
export function defaultLocalEnvPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", ".env");
}

let localEnvLoaded = false;

function ensureLocalEnvLoaded(): void {
  if (localEnvLoaded) {
    return;
  }
  localEnvLoaded = true;
  loadLocalEnvFile(defaultLocalEnvPath());
}

export function loadE2EEnv(
  env: NodeJS.ProcessEnv = process.env,
): E2EEnv {
  // Only auto-load package `.env` when reading real process.env (local DX).
  if (env === process.env) {
    ensureLocalEnvLoaded();
  }
  const baseRaw =
    trimOrUndefined(env.E2E_BASE_URL) ?? DEFAULT_E2E_BASE_URL;
  return {
    baseUrl: normalizeBaseUrl(baseRaw),
    shareToken: trimOrUndefined(env.E2E_SHARE_TOKEN),
    shareTripTitle: trimOrUndefined(env.E2E_SHARE_TRIP_TITLE),
    ownerAccessToken: trimOrUndefined(env.E2E_OWNER_ACCESS_TOKEN),
  };
}

/**
 * True when the suite has enough credentials to run (not merely a base URL).
 * Used for skip messaging in specs and CI.
 */
export function hasShareSmokeCredentials(env: E2EEnv): boolean {
  if (env.shareToken !== undefined) {
    return true;
  }
  return env.ownerAccessToken !== undefined;
}

export function shareSmokeSkipReason(env: E2EEnv): string | undefined {
  if (hasShareSmokeCredentials(env)) {
    return undefined;
  }
  return (
    "Share smoke skipped: set E2E_SHARE_TOKEN (+ optional E2E_SHARE_TRIP_TITLE) " +
    "or E2E_OWNER_ACCESS_TOKEN. See packages/e2e/README.md."
  );
}
