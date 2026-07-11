import { Schema as S } from "effect";
import { Instant } from "./instant.js";
import { CivilDate } from "./trip.js";

export const EnrichmentMeta = S.Struct({
  provider: S.String,
  fetchedAt: Instant,
  confidence: S.optional(S.Number),
  rawRef: S.optional(S.String),
});
export type EnrichmentMeta = typeof EnrichmentMeta.Type;

/** Static airport row (IATA → geo) for map pins and enrichment. */
export const Airport = S.Struct({
  iata: S.String.pipe(S.pattern(/^[A-Z]{3}$/)),
  name: S.String,
  city: S.optional(S.String),
  country: S.optional(S.String),
  lat: S.Number.pipe(S.between(-90, 90)),
  lng: S.Number.pipe(S.between(-180, 180)),
  timezone: S.optional(S.String),
});
export type Airport = typeof Airport.Type;

/** POST /api/v1/enrich/flight request body. */
export const EnrichFlightRequest = S.Struct({
  flightNumber: S.String.pipe(S.minLength(1), S.maxLength(16)),
  /** Civil date (YYYY-MM-DD) in the travel context. */
  date: CivilDate,
  /** Optional departure IATA to disambiguate multi-leg / codeshare. */
  departureAirportHint: S.optional(
    S.String.pipe(S.pattern(/^[A-Za-z]{3}$/)),
  ),
});
export type EnrichFlightRequest = typeof EnrichFlightRequest.Type;

export const FlightEndpointSuggestion = S.Struct({
  airportIata: S.String,
  airportName: S.optional(S.String),
  scheduledAt: Instant,
  terminal: S.optional(S.String),
  gate: S.optional(S.String),
  lat: S.optional(S.Number),
  lng: S.optional(S.Number),
  timezone: S.optional(S.String),
});
export type FlightEndpointSuggestion = typeof FlightEndpointSuggestion.Type;

/**
 * Successful enrichment suggestion (schedule found or cancelled).
 * UI prefills from this; user confirms save — never auto-written.
 */
export const FlightEnrichmentFound = S.Struct({
  status: S.Literal("found", "cancelled"),
  airlineCode: S.optional(S.String),
  airlineName: S.optional(S.String),
  flightNumber: S.String,
  departure: FlightEndpointSuggestion,
  arrival: FlightEndpointSuggestion,
  provider: S.String,
  fetchedAt: Instant,
  confidence: S.optional(S.Number),
  operatedBy: S.optional(S.String),
});
export type FlightEnrichmentFound = typeof FlightEnrichmentFound.Type;

/**
 * Schedule not found — HTTP 200 success DTO (not ApiErrorBody / NotFound).
 * Avoids conflating “trip not found” with “flight not found”.
 */
export const FlightEnrichmentNotFound = S.Struct({
  status: S.Literal("not_found"),
  provider: S.String,
  fetchedAt: Instant,
});
export type FlightEnrichmentNotFound = typeof FlightEnrichmentNotFound.Type;

export const FlightEnrichmentResponse = S.Union(
  FlightEnrichmentFound,
  FlightEnrichmentNotFound,
);
export type FlightEnrichmentResponse = typeof FlightEnrichmentResponse.Type;

/** Normalize airline+number tokens (e.g. "ua 100" / "UA100" → "UA100"). */
export function normalizeFlightNumber(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Split a flight designator into airline code + numeric portion when possible.
 * Accepts "UA100", "UA 100", "100" (number-only → airline undefined).
 */
export function parseFlightDesignator(raw: string): {
  readonly airlineCode: string | undefined;
  readonly number: string;
  readonly normalized: string;
} {
  const normalized = normalizeFlightNumber(raw);
  const match = /^([A-Z]{1,3})(\d{1,4}[A-Z]?)$/.exec(normalized);
  if (match === null) {
    return {
      airlineCode: undefined,
      number: normalized,
      normalized,
    };
  }
  return {
    airlineCode: match[1],
    number: match[2] ?? normalized,
    normalized,
  };
}

// ---------------------------------------------------------------------------
// Place search (MapTiler)
// ---------------------------------------------------------------------------

/**
 * Place search query: trim + reject whitespace-only so MapTiler never sees
 * `geocoding/.json`.
 */
const PlaceQuery = S.String.pipe(
  S.minLength(1),
  S.maxLength(200),
  S.filter((s) => s.trim().length > 0, {
    message: () => "query must not be blank",
  }),
  S.transform(S.String, {
    decode: (s) => s.trim(),
    encode: (s) => s,
  }),
);

/** POST /api/v1/enrich/place request body. */
export const EnrichPlaceRequest = S.Struct({
  /** Free-text place query for typeahead (hotel name, venue, address, city). */
  query: PlaceQuery,
  /** Optional proximity bias so results prefer a trip region. */
  proximity: S.optional(
    S.Struct({
      lat: S.Number.pipe(S.between(-90, 90)),
      lng: S.Number.pipe(S.between(-180, 180)),
    }),
  ),
  /** Max results (1–10). Providers default when omitted. */
  limit: S.optional(S.Number.pipe(S.int(), S.between(1, 10))),
  /** Prefer results in this ISO 639-1 language when supported. */
  language: S.optional(S.String.pipe(S.minLength(2), S.maxLength(5))),
});
export type EnrichPlaceRequest = typeof EnrichPlaceRequest.Type;

/**
 * One place suggestion for typeahead. UI maps this into GeoPoint + address
 * fields; user confirms save — never auto-written to itinerary.
 */
export const PlaceSuggestion = S.Struct({
  placeId: S.String,
  /** Primary display name (venue / locality). */
  label: S.String,
  /** Formatted address / hierarchy when available. */
  address: S.optional(S.String),
  lat: S.Number.pipe(S.between(-90, 90)),
  lng: S.Number.pipe(S.between(-180, 180)),
  /** Vendor place types (e.g. poi, address, municipality). */
  types: S.optional(S.Array(S.String)),
  /** Match quality 0–1 when the vendor provides it. */
  confidence: S.optional(S.Number),
});
export type PlaceSuggestion = typeof PlaceSuggestion.Type;

/**
 * Place search success DTO. `not_found` is HTTP 200 with empty `results`
 * (same pattern as flight enrichment — not ApiErrorBody).
 * Invariant: `found` ⇔ non-empty results; `not_found` ⇔ empty results.
 */
export const PlaceEnrichmentResponse = S.Struct({
  status: S.Literal("found", "not_found"),
  results: S.Array(PlaceSuggestion),
  provider: S.String,
  fetchedAt: Instant,
}).pipe(
  S.filter(
    (r) =>
      (r.status === "found" && r.results.length > 0) ||
      (r.status === "not_found" && r.results.length === 0),
    {
      message: () =>
        "PlaceEnrichmentResponse: found requires results; not_found requires empty results",
    },
  ),
);
export type PlaceEnrichmentResponse = typeof PlaceEnrichmentResponse.Type;
