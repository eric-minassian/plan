/**
 * Runtime configuration for the API Lambda.
 * Values come from environment variables set by ApiStack.
 */

export interface ApiConfig {
  readonly stage: string;
  readonly tableName: string | undefined;
  readonly authIssuer: string;
  readonly authAudience: string;
  /**
   * Public origin clients use when calling the API (no trailing slash),
   * e.g. `https://plan.ericminassian.com`. Used for DPoP `htu` reconstruction
   * instead of untrusted `X-Forwarded-Host`. When unset, fall back to `Host`.
   */
  readonly publicApiBaseUrl: string | undefined;
  /**
   * When false, DELETE /trips/:id returns 403.
   * Env: `TRIPS_DELETE_ENABLED` (`true`/`false`); default enabled.
   */
  readonly tripsDeleteEnabled: boolean;
  /**
   * Allowed browser Origins for POST /share/session.
   * Derived from PUBLIC_API_BASE_URL plus common Vite dev origins.
   */
  readonly shareAllowedOrigins: readonly string[];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const rawBase = env.PUBLIC_API_BASE_URL?.trim();
  const publicApiBaseUrl =
    rawBase !== undefined && rawBase.length > 0
      ? rawBase.replace(/\/$/, "")
      : undefined;
  return {
    stage: env.STAGE ?? "dev",
    tableName: env.TABLE_NAME,
    authIssuer: env.AUTH_ISSUER ?? "https://auth.ericminassian.com",
    authAudience: env.AUTH_AUDIENCE ?? "plan",
    publicApiBaseUrl,
    tripsDeleteEnabled: parseBoolFlag(env.TRIPS_DELETE_ENABLED, true),
    shareAllowedOrigins: buildShareAllowedOrigins(publicApiBaseUrl, env.STAGE),
  };
}

function buildShareAllowedOrigins(
  publicApiBaseUrl: string | undefined,
  stage: string | undefined,
): readonly string[] {
  const origins = new Set<string>();
  if (publicApiBaseUrl !== undefined) {
    origins.add(publicApiBaseUrl);
  }
  // Dogfood SPA hosts
  origins.add("https://plan.ericminassian.com");
  if (stage !== "prod") {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
    origins.add("http://localhost:4173");
    origins.add("http://127.0.0.1:4173");
  }
  return [...origins];
}

function parseBoolFlag(
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue;
  }
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") {
    return true;
  }
  if (v === "false" || v === "0" || v === "no" || v === "off") {
    return false;
  }
  return defaultValue;
}
