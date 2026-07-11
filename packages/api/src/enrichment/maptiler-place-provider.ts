import type {
  EnrichPlaceRequest,
  Instant,
  PlaceEnrichmentResponse,
  PlaceSuggestion,
} from "@tripplan/domain";
import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import {
  loadMapTilerCredentials,
  type MapTilerCredentials,
} from "./maptiler-secrets.js";
import { nowInstant } from "./now.js";
import type { PlaceProvider } from "./place-provider.js";

/** Default live fetch timeout (enrich p95 goal is < 2.5s; allow vendor headroom). */
export const MAPTILER_FETCH_TIMEOUT_MS = 8_000;

const DEFAULT_LIMIT = 5;

export interface MapTilerPlaceProviderOptions {
  readonly getCredentials?: () => Effect.Effect<MapTilerCredentials, AppError>;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Instant;
  /** Override fetch timeout in ms (tests). */
  readonly timeoutMs?: number;
}

/**
 * Live MapTiler Geocoding adapter. Selected when `enrichment.places.live=true`.
 *
 * Secrets via {@link loadMapTilerCredentials}. Empty features → 200 `not_found`.
 * No Google Places in v1.
 */
export class MapTilerPlaceProvider implements PlaceProvider {
  readonly name = "maptiler";
  readonly isLive = true;

  constructor(private readonly options: MapTilerPlaceProviderOptions = {}) {}

  search(
    query: EnrichPlaceRequest,
  ): Effect.Effect<PlaceEnrichmentResponse, AppError> {
    const getCredentials =
      this.options.getCredentials ?? (() => loadMapTilerCredentials());
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const clock = this.options.clock ?? (() => nowInstant());
    const timeoutMs = this.options.timeoutMs ?? MAPTILER_FETCH_TIMEOUT_MS;
    const providerName = this.name;

    return Effect.gen(function* () {
      const creds = yield* getCredentials();
      const limit = query.limit ?? DEFAULT_LIMIT;
      const params = new URLSearchParams({
        key: creds.apiKey,
        limit: String(limit),
        autocomplete: "true",
      });
      if (query.proximity !== undefined) {
        // MapTiler proximity is lon,lat
        params.set(
          "proximity",
          `${String(query.proximity.lng)},${String(query.proximity.lat)}`,
        );
      }
      if (query.language !== undefined && query.language.trim().length > 0) {
        params.set("language", query.language.trim());
      }

      const encodedQuery = encodeURIComponent(query.query.trim());
      const url = `https://api.maptiler.com/geocoding/${encodedQuery}.json?${params.toString()}`;

      const response = yield* fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: "GET",
          headers: { Accept: "application/json" },
        },
        timeoutMs,
      );

      if (response.status === 401 || response.status === 403) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("MapTiler rejected credentials"),
        );
      }

      if (response.status === 429) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("MapTiler rate limited"),
        );
      }

      // Post-network vendor rejection is billable (HTTP already happened).
      // Reserve ValidationError for local request-body decode only.
      if (response.status === 400) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("MapTiler rejected the place query"),
        );
      }

      if (!response.ok) {
        return yield* Effect.fail(
          AppError.upstreamUnavailable(
            `MapTiler returned HTTP ${String(response.status)}`,
          ),
        );
      }

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          AppError.upstreamUnavailable("MapTiler response read failed"),
      });
      if (text.trim().length === 0) {
        return {
          status: "not_found" as const,
          results: [],
          provider: providerName,
          fetchedAt: clock(),
        };
      }

      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return yield* Effect.fail(
          AppError.upstreamUnavailable("MapTiler returned invalid JSON"),
        );
      }

      return mapMapTilerBody(body, providerName, clock());
    });
  }
}

export function makeMapTilerPlaceProvider(
  options?: MapTilerPlaceProviderOptions,
): PlaceProvider {
  return new MapTilerPlaceProvider(options);
}

/**
 * Map MapTiler FeatureCollection into our place enrichment DTO.
 * Exported for unit tests.
 */
export function mapMapTilerBody(
  body: unknown,
  providerName: string,
  fetchedAt: Instant,
): PlaceEnrichmentResponse {
  const features = extractFeatures(body);
  const results: PlaceSuggestion[] = [];

  for (const feature of features) {
    const mapped = mapFeature(feature);
    if (mapped !== undefined) {
      results.push(mapped);
    }
  }

  if (results.length === 0) {
    return {
      status: "not_found",
      results: [],
      provider: providerName,
      fetchedAt,
    };
  }

  return {
    status: "found",
    results,
    provider: providerName,
    fetchedAt,
  };
}

function extractFeatures(body: unknown): readonly unknown[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const features = (body as Record<string, unknown>)["features"];
  if (!Array.isArray(features)) {
    return [];
  }
  return features;
}

function mapFeature(feature: unknown): PlaceSuggestion | undefined {
  if (feature === null || typeof feature !== "object" || Array.isArray(feature)) {
    return undefined;
  }
  const f = feature as Record<string, unknown>;

  const coords = resolveCoordinates(f);
  if (coords === undefined) {
    return undefined;
  }

  const placeId =
    typeof f["id"] === "string" && f["id"].trim().length > 0
      ? f["id"].trim()
      : undefined;
  if (placeId === undefined) {
    return undefined;
  }

  const label =
    pickString(f, "text") ??
    pickString(f, "place_name") ??
    pickString(f, "matching_text");
  if (label === undefined || label.length === 0) {
    return undefined;
  }

  const placeName = pickString(f, "place_name");
  const address = placeName;

  const types = Array.isArray(f["place_type"])
    ? f["place_type"].filter((t): t is string => typeof t === "string")
    : undefined;

  const relevance =
    typeof f["relevance"] === "number" && Number.isFinite(f["relevance"])
      ? f["relevance"]
      : undefined;

  return {
    placeId,
    label,
    ...(address !== undefined ? { address } : {}),
    lat: coords.lat,
    lng: coords.lng,
    ...(types !== undefined && types.length > 0 ? { types } : {}),
    ...(relevance !== undefined ? { confidence: relevance } : {}),
  };
}

function resolveCoordinates(
  feature: Record<string, unknown>,
): { lat: number; lng: number } | undefined {
  const center = feature["center"];
  if (Array.isArray(center) && center.length >= 2) {
    const lng = center[0];
    const lat = center[1];
    if (
      typeof lng === "number" &&
      typeof lat === "number" &&
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      return { lat, lng };
    }
  }

  const geometry = feature["geometry"];
  if (
    geometry !== null &&
    typeof geometry === "object" &&
    !Array.isArray(geometry)
  ) {
    const g = geometry as Record<string, unknown>;
    if (g["type"] === "Point" && Array.isArray(g["coordinates"])) {
      const coords = g["coordinates"];
      const lng = coords[0];
      const lat = coords[1];
      if (
        typeof lng === "number" &&
        typeof lat === "number" &&
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
      ) {
        return { lat, lng };
      }
    }
  }

  return undefined;
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
        return AppError.upstreamUnavailable("MapTiler request timed out");
      }
      return AppError.upstreamUnavailable("MapTiler request failed");
    },
  });
}
