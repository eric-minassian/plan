import type {
  EnrichFlightRequest,
  FlightEnrichmentResponse,
  Instant,
} from "@tripplan/domain";
import {
  normalizeFlightNumber,
  normalizeInstant,
  parseFlightDesignator,
  tryCanonicalizeInstant,
} from "@tripplan/domain";
import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import {
  loadAeroDataBoxCredentials,
  type AeroDataBoxCredentials,
} from "./aerodatabox-secrets.js";
import { airportGeo } from "./airports.js";
import type { FlightProvider } from "./flight-provider.js";
import { nowInstant } from "./now.js";

/** Default live fetch timeout (enrich p95 goal is < 2.5s; allow vendor headroom). */
export const AERODATABOX_FETCH_TIMEOUT_MS = 8_000;

export interface AeroDataBoxFlightProviderOptions {
  readonly getCredentials?: () => Effect.Effect<
    AeroDataBoxCredentials,
    AppError
  >;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Instant;
  /** Override fetch timeout in ms (tests). */
  readonly timeoutMs?: number;
}

/**
 * Live AeroDataBox adapter (RapidAPI). Selected when `enrichment.flight.live=true`.
 *
 * Secrets via {@link loadAeroDataBoxCredentials}. Empty results (204 / 404 /
 * empty body) → 200 `not_found`. Multi-candidate without hint → AmbiguousEnrichment.
 */
export class AeroDataBoxFlightProvider implements FlightProvider {
  readonly name = "aerodatabox";
  readonly isLive = true;

  constructor(private readonly options: AeroDataBoxFlightProviderOptions = {}) {}

  lookup(
    query: EnrichFlightRequest,
  ): Effect.Effect<FlightEnrichmentResponse, AppError> {
    const getCredentials =
      this.options.getCredentials ?? (() => loadAeroDataBoxCredentials());
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const clock = this.options.clock ?? (() => nowInstant());
    const timeoutMs = this.options.timeoutMs ?? AERODATABOX_FETCH_TIMEOUT_MS;
    const providerName = this.name;

    return Effect.gen(function* () {
      const creds = yield* getCredentials();
      const designator = parseFlightDesignator(query.flightNumber);
      const flightPath = encodeURIComponent(
        designator.normalized.length > 0
          ? designator.normalized
          : normalizeFlightNumber(query.flightNumber),
      );
      const datePath = encodeURIComponent(query.date);
      // Departure-day role so civil date matches itinerary travel date semantics.
      const url = `https://${creds.host}/flights/number/${flightPath}/${datePath}?dateLocalRole=Departure`;

      const response = yield* fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: "GET",
          headers: {
            "X-RapidAPI-Key": creds.apiKey,
            "X-RapidAPI-Host": creds.host,
            Accept: "application/json",
          },
        },
        timeoutMs,
      );

      // AeroDataBox documents 204 No Content when nothing matches; 404 also empty.
      if (response.status === 204 || response.status === 404) {
        return {
          status: "not_found" as const,
          provider: providerName,
          fetchedAt: clock(),
        };
      }

      if (response.status === 401 || response.status === 403) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("AeroDataBox rejected credentials"),
        );
      }

      if (response.status === 429) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("AeroDataBox rate limited"),
        );
      }

      if (!response.ok) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable(
            `AeroDataBox returned HTTP ${String(response.status)}`,
          ),
        );
      }

      // Empty 200 body (or Content-Length 0) → not_found, not invalid JSON / 502.
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          AppError.upstreamUnavailable("AeroDataBox response read failed"),
      });
      if (text.trim().length === 0) {
        return {
          status: "not_found" as const,
          provider: providerName,
          fetchedAt: clock(),
        };
      }

      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("AeroDataBox returned invalid JSON"),
        );
      }

      return yield* mapAeroDataBoxBody(body, query, providerName, clock());
    });
  }
}

export function makeAeroDataBoxFlightProvider(
  options?: AeroDataBoxFlightProviderOptions,
): FlightProvider {
  return new AeroDataBoxFlightProvider(options);
}

function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Effect.Effect<Response, AppError> {
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) => {
      if (cause instanceof Error && cause.name === "AbortError") {
        return AppError.upstreamUnavailable("AeroDataBox request timed out");
      }
      return AppError.upstreamUnavailable("AeroDataBox request failed");
    },
  });
}

/**
 * Map RapidAPI AeroDataBox flight-number payload into our DTO.
 * Accepts array or single-object shapes commonly returned by the API.
 */
export function mapAeroDataBoxBody(
  body: unknown,
  query: EnrichFlightRequest,
  providerName: string,
  fetchedAt: Instant,
): Effect.Effect<FlightEnrichmentResponse, AppError> {
  const rows = normalizeRows(body);
  if (rows.length === 0) {
    return Effect.succeed({
      status: "not_found",
      provider: providerName,
      fetchedAt,
    });
  }

  const hint = query.departureAirportHint?.toUpperCase();
  let filtered = rows;
  if (hint !== undefined) {
    filtered = rows.filter((row) => iataFromLeg(row, "departure") === hint);
    if (filtered.length === 0) {
      return Effect.succeed({
        status: "not_found",
        provider: providerName,
        fetchedAt,
      });
    }
  }

  if (filtered.length > 1) {
    return Effect.fail(
      AppError.ambiguousEnrichment(
        "Multiple matching flights; refine with departureAirportHint",
        {
          candidates: filtered.slice(0, 5).map((row) => ({
            departureAirport: iataFromLeg(row, "departure"),
            arrivalAirport: iataFromLeg(row, "arrival"),
            flightNumber: stringField(row, "number") ?? query.flightNumber,
          })),
        },
      ),
    );
  }

  const row = filtered[0];
  if (row === undefined) {
    return Effect.succeed({
      status: "not_found",
      provider: providerName,
      fetchedAt,
    });
  }

  const depIata = iataFromLeg(row, "departure");
  const arrIata = iataFromLeg(row, "arrival");
  const depAt = scheduledAtFromLeg(row, "departure");
  const arrAt = scheduledAtFromLeg(row, "arrival");
  if (
    depIata === undefined ||
    arrIata === undefined ||
    depAt === undefined ||
    arrAt === undefined
  ) {
    return Effect.succeed({
      status: "not_found",
      provider: providerName,
      fetchedAt,
    });
  }

  const statusRaw = stringField(row, "status")?.toLowerCase() ?? "";
  const status = statusRaw.includes("cancel")
    ? ("cancelled" as const)
    : ("found" as const);

  const airline = asRecord(row["airline"]);
  const airlineCode =
    (airline !== undefined ? stringField(airline, "iata") : undefined) ??
    parseFlightDesignator(query.flightNumber).airlineCode;
  const airlineName =
    airline !== undefined ? stringField(airline, "name") : undefined;

  // Normalize to numeric portion when it matches airline code (consistent with mock).
  const flightNumber = normalizeStoredFlightNumber(
    stringField(row, "number"),
    airlineCode,
    query.flightNumber,
  );

  const depGeo = airportGeo(depIata);
  const arrGeo = airportGeo(arrIata);
  const depLeg = asRecord(row["departure"]);
  const arrLeg = asRecord(row["arrival"]);
  const depTerminal =
    depLeg !== undefined ? stringField(depLeg, "terminal") : undefined;
  const arrTerminal =
    arrLeg !== undefined ? stringField(arrLeg, "terminal") : undefined;

  return Effect.succeed({
    status,
    ...(airlineCode !== undefined ? { airlineCode } : {}),
    ...(airlineName !== undefined ? { airlineName } : {}),
    flightNumber,
    departure: {
      airportIata: depIata,
      ...(depGeo !== undefined ? { airportName: depGeo.name } : {}),
      scheduledAt: depAt,
      ...(depTerminal !== undefined ? { terminal: depTerminal } : {}),
      ...(depGeo !== undefined
        ? { lat: depGeo.lat, lng: depGeo.lng, timezone: depGeo.timezone }
        : {}),
    },
    arrival: {
      airportIata: arrIata,
      ...(arrGeo !== undefined ? { airportName: arrGeo.name } : {}),
      scheduledAt: arrAt,
      ...(arrTerminal !== undefined ? { terminal: arrTerminal } : {}),
      ...(arrGeo !== undefined
        ? { lat: arrGeo.lat, lng: arrGeo.lng, timezone: arrGeo.timezone }
        : {}),
    },
    provider: providerName,
    fetchedAt,
  });
}

/**
 * Prefer bare number (e.g. "100") when vendor returns "UA100" and airline is UA.
 * Falls back to designator number from the query.
 */
export function normalizeStoredFlightNumber(
  rawNumber: string | undefined,
  airlineCode: string | undefined,
  queryFlightNumber: string,
): string {
  const fromQuery = parseFlightDesignator(queryFlightNumber).number;
  if (rawNumber === undefined || rawNumber.trim().length === 0) {
    return fromQuery;
  }
  const parsed = parseFlightDesignator(rawNumber);
  if (
    airlineCode !== undefined &&
    parsed.airlineCode !== undefined &&
    parsed.airlineCode.toUpperCase() === airlineCode.toUpperCase()
  ) {
    return parsed.number;
  }
  // Vendor "number" sometimes is digits-only already.
  if (/^\d{1,4}[A-Z]?$/i.test(rawNumber.trim())) {
    return rawNumber.trim().toUpperCase();
  }
  // Full designator without matching airline code — still strip if parseable.
  if (parsed.airlineCode !== undefined) {
    return parsed.number;
  }
  return rawNumber.trim();
}

function normalizeRows(body: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter(
      (x): x is Record<string, unknown> =>
        x !== null && typeof x === "object" && !Array.isArray(x),
    );
  }
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["flights", "items", "data"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        return normalizeRows(nested);
      }
    }
    return [record];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function iataFromLeg(
  row: Record<string, unknown>,
  leg: "departure" | "arrival",
): string | undefined {
  const legObj = asRecord(row[leg]);
  if (legObj === undefined) {
    return undefined;
  }
  const airport = asRecord(legObj["airport"]);
  const iata =
    (airport !== undefined ? stringField(airport, "iata") : undefined) ??
    stringField(legObj, "airport") ??
    stringField(legObj, "iata");
  return iata !== undefined ? iata.toUpperCase() : undefined;
}

function scheduledAtFromLeg(
  row: Record<string, unknown>,
  leg: "departure" | "arrival",
): Instant | undefined {
  const legObj = asRecord(row[leg]);
  if (legObj === undefined) {
    return undefined;
  }
  const times = asRecord(legObj["scheduledTime"]);
  const candidates: Array<string | undefined> = [
    times !== undefined ? stringField(times, "local") : undefined,
    times !== undefined ? stringField(times, "utc") : undefined,
    stringField(legObj, "scheduledTimeLocal"),
    stringField(legObj, "scheduledTimeUtc"),
  ];
  for (const c of candidates) {
    if (c === undefined) {
      continue;
    }
    const canonical = tryCanonicalizeInstant(c);
    if (canonical !== null) {
      return normalizeInstant(canonical);
    }
  }
  return undefined;
}
