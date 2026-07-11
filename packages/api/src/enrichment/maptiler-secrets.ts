import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";

export interface MapTilerCredentials {
  readonly apiKey: string;
}

/**
 * Resolve MapTiler server credentials from environment (Secrets Manager injects
 * these at runtime, or ops sets them for local dogfood).
 *
 * Supported env:
 * - `MAPTILER_API_KEY`
 * - `MAPTILER_SECRET_JSON` — full secret payload `{"apiKey":"…"}`
 *   (from SM get-secret-value; FoundationStack MapTilerSecret)
 */
export function loadMapTilerCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<MapTilerCredentials, AppError> {
  return Effect.sync(() => {
    const fromJson = parseSecretJson(env.MAPTILER_SECRET_JSON);
    if (fromJson !== undefined) {
      return fromJson;
    }
    const apiKey = env.MAPTILER_API_KEY?.trim();
    if (apiKey !== undefined && apiKey.length > 0) {
      return { apiKey };
    }
    return undefined;
  }).pipe(
    Effect.flatMap((creds) =>
      creds === undefined
        ? Effect.fail(
            AppError.upstreamUnavailable(
              "MapTiler credentials not configured (set MAPTILER_API_KEY or MAPTILER_SECRET_JSON)",
            ),
          )
        : Effect.succeed(creds),
    ),
  );
}

function parseSecretJson(
  raw: string | undefined,
): MapTilerCredentials | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const apiKey = record["apiKey"];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return undefined;
  }
  return { apiKey: apiKey.trim() };
}
