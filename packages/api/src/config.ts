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
  };
}
