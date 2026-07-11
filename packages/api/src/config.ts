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
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const rawBase = env.PUBLIC_API_BASE_URL?.trim();
  return {
    stage: env.STAGE ?? "dev",
    tableName: env.TABLE_NAME,
    authIssuer: env.AUTH_ISSUER ?? "https://auth.ericminassian.com",
    authAudience: env.AUTH_AUDIENCE ?? "plan",
    publicApiBaseUrl:
      rawBase !== undefined && rawBase.length > 0
        ? rawBase.replace(/\/$/, "")
        : undefined,
    tripsDeleteEnabled: parseBoolFlag(env.TRIPS_DELETE_ENABLED, true),
  };
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
