import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";

export interface AeroDataBoxCredentials {
  readonly apiKey: string;
  readonly host: string;
}

const DEFAULT_HOST = "aerodatabox.p.rapidapi.com";

/**
 * Resolve AeroDataBox credentials from environment (Secrets Manager injects
 * these at runtime, or ops sets them for local dogfood).
 *
 * Supported env:
 * - `AERODATABOX_API_KEY` + optional `AERODATABOX_HOST`
 * - `AERODATABOX_SECRET_JSON` — full secret payload
 *   `{"apiKey":"…","host":"aerodatabox.p.rapidapi.com"}` (from SM get-secret-value)
 */
export function loadAeroDataBoxCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<AeroDataBoxCredentials, AppError> {
  return Effect.sync(() => {
    const fromJson = parseSecretJson(env.AERODATABOX_SECRET_JSON);
    if (fromJson !== undefined) {
      return fromJson;
    }
    const apiKey = env.AERODATABOX_API_KEY?.trim();
    if (apiKey !== undefined && apiKey.length > 0) {
      const host = env.AERODATABOX_HOST?.trim();
      return {
        apiKey,
        host:
          host !== undefined && host.length > 0 ? host : DEFAULT_HOST,
      };
    }
    return undefined;
  }).pipe(
    Effect.flatMap((creds) =>
      creds === undefined
        ? Effect.fail(
            AppError.upstreamUnavailable(
              "AeroDataBox credentials not configured (set AERODATABOX_API_KEY or AERODATABOX_SECRET_JSON)",
            ),
          )
        : Effect.succeed(creds),
    ),
  );
}

function parseSecretJson(
  raw: string | undefined,
): AeroDataBoxCredentials | undefined {
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
  const hostRaw = record["host"];
  const host =
    typeof hostRaw === "string" && hostRaw.trim().length > 0
      ? hostRaw.trim()
      : DEFAULT_HOST;
  return { apiKey: apiKey.trim(), host };
}
