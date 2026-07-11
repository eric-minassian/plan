/**
 * Static IATA → geo lookup for map pins when flights have airport codes
 * but no startLocation/endLocation yet.
 *
 * Dataset: versioned `data/airports/v1.json` (SPA serves a copy at
 * `/data/airports/v1.json`). Empty array is valid until enrichment populates it.
 */

export type AirportRecord = {
  readonly iata: string;
  readonly lat: number;
  readonly lng: number;
  readonly name?: string;
  readonly timezone?: string;
};

export type AirportsIndex = {
  /** Resolve IATA (case-insensitive). */
  readonly get: (iata: string) => AirportRecord | undefined;
  readonly size: number;
};

export type AirportsLoadStatus = "loading" | "ready" | "error";

export type AirportsLoadState = {
  readonly index: AirportsIndex;
  readonly status: AirportsLoadStatus;
};

const EMPTY_INDEX: AirportsIndex = {
  get: () => undefined,
  size: 0,
};

/** Successful index only — failures are not cached so callers can retry. */
let successCache: AirportsIndex | undefined;
/** In-flight request shared across concurrent callers. */
let inFlight: Promise<AirportsIndex> | undefined;

/** Build an index from an in-memory list (tests / inject). */
export function createAirportsIndex(
  records: readonly AirportRecord[],
): AirportsIndex {
  const byIata = new Map<string, AirportRecord>();
  for (const record of records) {
    const code = normalizeIata(record.iata);
    if (code === undefined) {
      continue;
    }
    byIata.set(code, { ...record, iata: code });
  }
  return {
    get(iata: string): AirportRecord | undefined {
      const code = normalizeIata(iata);
      if (code === undefined) {
        return undefined;
      }
      return byIata.get(code);
    },
    size: byIata.size,
  };
}

export function emptyAirportsIndex(): AirportsIndex {
  return EMPTY_INDEX;
}

/** Normalize to 3-letter uppercase IATA, or undefined if invalid. */
export function normalizeIata(raw: string): string | undefined {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return undefined;
  }
  return code;
}

/**
 * Parse airports JSON body. Accepts an array of records; unknown/invalid
 * rows are skipped rather than failing the whole load.
 */
export function parseAirportsDataset(body: unknown): AirportRecord[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const out: AirportRecord[] = [];
  for (const row of body) {
    const parsed = parseAirportRecord(row);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

function parseAirportRecord(row: unknown): AirportRecord | undefined {
  if (row === null || typeof row !== "object") {
    return undefined;
  }
  const rec = row as Record<string, unknown>;
  if (typeof rec["iata"] !== "string") {
    return undefined;
  }
  const iata = normalizeIata(rec["iata"]);
  if (iata === undefined) {
    return undefined;
  }
  const lat = rec["lat"];
  const lng = rec["lng"];
  if (typeof lat !== "number" || typeof lng !== "number") {
    return undefined;
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return undefined;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return undefined;
  }
  const name = typeof rec["name"] === "string" ? rec["name"] : undefined;
  const timezone =
    typeof rec["timezone"] === "string" ? rec["timezone"] : undefined;
  return { iata, lat, lng, name, timezone };
}

/**
 * Load the SPA airports dataset from `/data/airports/v1.json`.
 *
 * Successful results are cached for the session. Failures are **not** cached
 * so a later mount/call can retry (offline blip, missing public asset, etc.).
 * Concurrent callers share one in-flight request.
 */
export function loadAirportsIndex(
  fetchImpl: typeof fetch = fetch,
): Promise<AirportsIndex> {
  if (successCache !== undefined) {
    return Promise.resolve(successCache);
  }
  if (inFlight !== undefined) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const response = await fetchImpl("/data/airports/v1.json", {
        headers: { Accept: "application/json" },
        cache: "force-cache",
      });
      if (!response.ok) {
        throw new Error(
          `Failed to load airports (${String(response.status)} ${response.statusText})`,
        );
      }
      const body: unknown = await response.json();
      const index = createAirportsIndex(parseAirportsDataset(body));
      successCache = index;
      return index;
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

/** Test helper: clear success + in-flight caches. */
export function resetAirportsIndexCache(): void {
  successCache = undefined;
  inFlight = undefined;
}
