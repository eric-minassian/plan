import type {
  EnrichPlaceRequest,
  PlaceEnrichmentResponse,
} from "@tripplan/domain";
import { Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import type { PlaceProvider } from "./place-provider.js";

/** Default short TTL for typeahead cache (reduces rate-limit + vendor spend). */
export const DEFAULT_PLACE_SEARCH_CACHE_TTL_MS = 30_000;

export interface PlaceSearchCache {
  readonly get: (
    query: EnrichPlaceRequest,
  ) => PlaceEnrichmentResponse | undefined;
  readonly set: (
    query: EnrichPlaceRequest,
    value: PlaceEnrichmentResponse,
  ) => void;
}

/**
 * In-memory place search cache keyed by normalized query + proximity + limit.
 * Per Lambda instance; good enough to blunt typeahead keystroke bursts.
 */
export function makePlaceSearchCache(
  ttlMs: number = DEFAULT_PLACE_SEARCH_CACHE_TTL_MS,
  now: () => number = () => Date.now(),
): PlaceSearchCache {
  const entries = new Map<
    string,
    { readonly expiresAt: number; readonly value: PlaceEnrichmentResponse }
  >();

  return {
    get(query) {
      const key = placeCacheKey(query);
      const hit = entries.get(key);
      if (hit === undefined) {
        return undefined;
      }
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(query, value) {
      entries.set(placeCacheKey(query), {
        expiresAt: now() + ttlMs,
        value,
      });
    },
  };
}

export function placeCacheKey(query: EnrichPlaceRequest): string {
  const q = query.query.trim().toLowerCase();
  const limit = query.limit ?? "";
  const lang = query.language ?? "";
  const prox =
    query.proximity !== undefined
      ? `${String(query.proximity.lat)},${String(query.proximity.lng)}`
      : "";
  return `${q}|${String(limit)}|${lang}|${prox}`;
}

/**
 * Wrap a PlaceProvider with a short-TTL response cache (does not change isLive).
 */
export function withPlaceSearchCache(
  provider: PlaceProvider,
  cache: PlaceSearchCache = makePlaceSearchCache(),
): PlaceProvider {
  return {
    name: provider.name,
    isLive: provider.isLive,
    search(
      query: EnrichPlaceRequest,
    ): Effect.Effect<PlaceEnrichmentResponse, AppError> {
      const hit = cache.get(query);
      if (hit !== undefined) {
        return Effect.succeed(hit);
      }
      return provider.search(query).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            cache.set(query, value);
          }),
        ),
      );
    },
  };
}
