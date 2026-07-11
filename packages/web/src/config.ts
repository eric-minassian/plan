/**
 * Runtime SPA config loaded from `/config.json` (not baked into the bundle).
 * Production file is written by WebStack; local uses `public/config.json`.
 */
export interface AppConfig {
  readonly authIssuer: string;
  readonly authClientId: string;
  /** Referrer-restricted MapTiler browser key; empty until ops fills it. */
  readonly mapTilerApiKey: string;
}

export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch("/config.json", {
    headers: { Accept: "application/json" },
    cache: "no-cache",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load /config.json (${String(response.status)} ${response.statusText})`,
    );
  }
  const body: unknown = await response.json();
  return parseAppConfig(body);
}

function parseAppConfig(body: unknown): AppConfig {
  if (body === null || typeof body !== "object") {
    throw new Error("config.json must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  return {
    authIssuer: requireString(record, "authIssuer"),
    authClientId: requireString(record, "authClientId"),
    mapTilerApiKey: optionalString(record, "mapTilerApiKey") ?? "",
  };
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`config.json missing non-empty string "${key}"`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`config.json "${key}" must be a string`);
  }
  return value;
}
