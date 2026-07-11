/**
 * Runtime configuration for the API Lambda.
 * Values come from environment variables set by ApiStack.
 */

export interface ApiConfig {
  readonly stage: string;
  readonly tableName: string | undefined;
  /** S3 documents bucket name (presigned attachments). */
  readonly docsBucketName: string | undefined;
  /** AWS region for S3 client (defaults to us-east-1). */
  readonly awsRegion: string;
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
  /**
   * When true, flight enrichment uses AeroDataBox (live). Default false → mock.
   * Env: `ENRICHMENT_FLIGHT_LIVE` (design flag `enrichment.flight.live`).
   */
  readonly enrichmentFlightLive: boolean;
  /**
   * Max enrich API calls per owner per rolling hour. Default 60.
   * Env: `ENRICHMENT_RATE_LIMIT_PER_HOUR`.
   */
  readonly enrichmentRateLimitPerHour: number;
  /**
   * Monthly USD hard cap for live enrichment spend. When exceeded, live
   * lookups return UpstreamUnavailable without calling the vendor.
   * Env: `ENRICHMENT_MONTHLY_BUDGET_USD` (default 25).
   */
  readonly enrichmentMonthlyBudgetUsd: number;
  /**
   * Estimated USD charged per live flight lookup against the monthly budget.
   * Env: `ENRICHMENT_LIVE_FLIGHT_COST_USD` (default 0.01).
   */
  readonly enrichmentLiveFlightCostUsd: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const rawBase = env.PUBLIC_API_BASE_URL?.trim();
  const publicApiBaseUrl =
    rawBase !== undefined && rawBase.length > 0
      ? rawBase.replace(/\/$/, "")
      : undefined;
  const rawBucket = env.DOCS_BUCKET_NAME?.trim();
  return {
    stage: env.STAGE ?? "dev",
    tableName: env.TABLE_NAME,
    docsBucketName:
      rawBucket !== undefined && rawBucket.length > 0 ? rawBucket : undefined,
    awsRegion: env.AWS_REGION?.trim() || "us-east-1",
    authIssuer: env.AUTH_ISSUER ?? "https://auth.ericminassian.com",
    authAudience: env.AUTH_AUDIENCE ?? "plan",
    publicApiBaseUrl,
    tripsDeleteEnabled: parseBoolFlag(env.TRIPS_DELETE_ENABLED, true),
    shareAllowedOrigins: buildShareAllowedOrigins(publicApiBaseUrl, env.STAGE),
    enrichmentFlightLive: parseBoolFlag(env.ENRICHMENT_FLIGHT_LIVE, false),
    enrichmentRateLimitPerHour: parsePositiveInt(
      env.ENRICHMENT_RATE_LIMIT_PER_HOUR,
      60,
    ),
    enrichmentMonthlyBudgetUsd: parseNonNegativeNumber(
      env.ENRICHMENT_MONTHLY_BUDGET_USD,
      25,
    ),
    enrichmentLiveFlightCostUsd: parseNonNegativeNumber(
      env.ENRICHMENT_LIVE_FLIGHT_COST_USD,
      0.01,
    ),
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

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return defaultValue;
  }
  return n;
}

function parseNonNegativeNumber(
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return defaultValue;
  }
  return n;
}
