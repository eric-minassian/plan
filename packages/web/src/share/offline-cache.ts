import type { ShareTripDTO } from "@tripplan/domain";
import { ShareTripDTO as ShareTripDTOSchema } from "@tripplan/domain";
import { Either, Schema as S } from "effect";

/**
 * localStorage key for the last successfully opened shared trip.
 * App-level airplane-mode snapshot — the service worker does **not** Cache
 * Storage `GET /api/v1/share/trip` (NetworkOnly) so online loads never
 * silently succeed with a stale SW response.
 */
export const LAST_SHARE_TRIP_STORAGE_KEY = "tripplan:share:lastTrip" as const;

/** Named Workbox cache that may exist from older builds; still cleared on leave. */
export const SHARE_TRIP_SW_CACHE_NAME = "tripplan-share-trip" as const;

/** Match SW maxAge and bound how long a shared device keeps itinerary JSON. */
export const LAST_SHARE_TRIP_MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000;

export interface LastShareTripCache {
  readonly savedAt: string;
  readonly trip: ShareTripDTO;
}

const CacheEnvelope = S.Struct({
  savedAt: S.String,
  trip: ShareTripDTOSchema,
});

export type ShareTripStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): ShareTripStorage | undefined {
  try {
    if (typeof localStorage === "undefined") {
      return undefined;
    }
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Persist the last-opened share trip for offline re-open. */
export function saveLastShareTrip(
  trip: ShareTripDTO,
  storage: ShareTripStorage | undefined = defaultStorage(),
  now: () => Date = () => new Date(),
): void {
  if (storage === undefined) {
    return;
  }
  const envelope: LastShareTripCache = {
    savedAt: now().toISOString(),
    trip,
  };
  try {
    storage.setItem(LAST_SHARE_TRIP_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota / private mode — offline fallback is best-effort.
  }
}

/**
 * Read and validate the last-opened share trip, if any.
 * Entries older than {@link LAST_SHARE_TRIP_MAX_AGE_MS} are cleared and ignored.
 */
export function loadLastShareTrip(
  storage: ShareTripStorage | undefined = defaultStorage(),
  now: () => Date = () => new Date(),
): LastShareTripCache | undefined {
  if (storage === undefined) {
    return undefined;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(LAST_SHARE_TRIP_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    clearLastShareTrip(storage);
    return undefined;
  }
  const decoded = S.decodeUnknownEither(CacheEnvelope)(json);
  if (Either.isLeft(decoded)) {
    clearLastShareTrip(storage);
    return undefined;
  }
  const envelope = decoded.right;
  const savedMs = Date.parse(envelope.savedAt);
  if (Number.isNaN(savedMs) || now().getTime() - savedMs > LAST_SHARE_TRIP_MAX_AGE_MS) {
    clearLastShareTrip(storage);
    return undefined;
  }
  return envelope;
}

/** Drop the offline share cache (e.g. after "Leave share" or online revoke). */
export function clearLastShareTrip(
  storage: ShareTripStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined) {
    return;
  }
  try {
    storage.removeItem(LAST_SHARE_TRIP_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Best-effort: delete any leftover Workbox runtime cache named
 * {@link SHARE_TRIP_SW_CACHE_NAME} (legacy NetworkFirst builds + future safety).
 */
export async function clearShareTripServiceWorkerCache(
  cachesApi: CacheStorage | undefined = globalThis.caches,
): Promise<void> {
  if (cachesApi === undefined) {
    return;
  }
  try {
    await cachesApi.delete(SHARE_TRIP_SW_CACHE_NAME);
  } catch {
    // SW Cache Storage may be unavailable (insecure context, etc.).
  }
}

/** Clear app + SW durable share offline stores (Leave, revoke, 401/403/410). */
export async function clearAllShareOfflineStores(
  storage: ShareTripStorage | undefined = defaultStorage(),
  cachesApi: CacheStorage | undefined = globalThis.caches,
): Promise<void> {
  clearLastShareTrip(storage);
  await clearShareTripServiceWorkerCache(cachesApi);
}

/** Human-readable age for offline banners (e.g. "about 2 hours ago"). */
export function formatCacheAge(
  savedAt: string,
  now: () => Date = () => new Date(),
): string {
  const savedMs = Date.parse(savedAt);
  if (Number.isNaN(savedMs)) {
    return "earlier";
  }
  const deltaMs = Math.max(0, now().getTime() - savedMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${String(minutes)} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return hours === 1 ? "1 hour ago" : `${String(hours)} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${String(days)} days ago`;
}
