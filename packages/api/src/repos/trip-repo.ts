import type {
  CreateItineraryItem,
  CreateTrip,
  ItineraryItem,
  Trip,
  UpdateItineraryItem,
  UpdateTrip,
} from "@tripplan/domain";
import { normalizeInstant } from "@tripplan/domain";
import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import { applyItemPatch, buildCreatedItem } from "./item-build.js";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ITEMS_PER_TRIP,
  REORDER_CHUNK_SIZE,
  chunkArray,
  computeReorderSortKeys,
  isFullPermutation,
  nextAppendSortKey,
} from "./reorder.js";

/** Hard quota: active (non-deleted) trips per owner. */
export const MAX_ACTIVE_TRIPS_PER_OWNER = 100;

/** Default page size for list owned trips. */
export const TRIP_LIST_PAGE_SIZE = 50;

export {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ITEMS_PER_TRIP,
  REORDER_CHUNK_SIZE,
} from "./reorder.js";

export interface ListTripsResult {
  readonly trips: readonly Trip[];
  readonly nextCursor: string | undefined;
}

export interface ReorderItemsResult {
  readonly trip: Trip;
  readonly items: readonly ItineraryItem[];
}

export interface CreateItemOptions {
  readonly idempotencyKey?: string;
}

export interface TripRepository {
  /**
   * Create a trip for owner. Enforces {@link MAX_ACTIVE_TRIPS_PER_OWNER}.
   * Assigns tripId, version=1, status=active.
   *
   * Quota is check-then-act (**best-effort** under concurrent creates — both
   * in-memory and Dynamo). Soft-deleted trips do not count. Atomic owner
   * counter deferred; serial create beyond 100 is hard-rejected.
   */
  readonly create: (
    ownerId: string,
    input: CreateTrip,
  ) => Effect.Effect<Trip, AppError>;

  /**
   * Get trip meta by owner path. Returns undefined when missing or soft-deleted
   * (or status deleting) — callers map to 404 for owner GET.
   */
  readonly getActiveForOwner: (
    ownerId: string,
    tripId: string,
  ) => Effect.Effect<Trip | undefined, AppError>;

  /**
   * List active trips for owner (hides deleted/deleting), cursor pagination.
   */
  readonly listActiveForOwner: (
    ownerId: string,
    options: {
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Effect.Effect<ListTripsResult, AppError>;

  /**
   * Conditional update by version. 409 on mismatch; 404 if missing/deleted.
   */
  readonly update: (
    ownerId: string,
    tripId: string,
    expectedVersion: number,
    patch: UpdateTrip,
  ) => Effect.Effect<Trip, AppError>;

  /**
   * Interim soft-delete: status=deleted + deletedAt. No child cascade.
   * 404 if already missing/deleted.
   */
  readonly softDelete: (
    ownerId: string,
    tripId: string,
  ) => Effect.Effect<Trip, AppError>;

  /**
   * List items for an active owned trip, ordered by sortKey ascending.
   * 404 if trip missing/not owned/deleted.
   */
  readonly listItems: (
    ownerId: string,
    tripId: string,
  ) => Effect.Effect<readonly ItineraryItem[], AppError>;

  /**
   * Get a single item. 404 (undefined) if trip or item missing / not owned.
   */
  readonly getItem: (
    ownerId: string,
    tripId: string,
    itemId: string,
  ) => Effect.Effect<ItineraryItem | undefined, AppError>;

  /**
   * Create item. Server assigns itemId, sortKey, version=1.
   * Optional Idempotency-Key (max 128). Enforces max {@link MAX_ITEMS_PER_TRIP}.
   */
  readonly createItem: (
    ownerId: string,
    tripId: string,
    input: CreateItineraryItem,
    options?: CreateItemOptions,
  ) => Effect.Effect<ItineraryItem, AppError>;

  /**
   * Conditional update by item version (If-Match). Type immutable at schema layer.
   * 409 on version mismatch; 404 if missing.
   */
  readonly updateItem: (
    ownerId: string,
    tripId: string,
    itemId: string,
    expectedVersion: number,
    patch: UpdateItineraryItem,
  ) => Effect.Effect<ItineraryItem, AppError>;

  /**
   * Delete item (attachments cascade deferred). 404 if missing.
   */
  readonly deleteItem: (
    ownerId: string,
    tripId: string,
    itemId: string,
  ) => Effect.Effect<void, AppError>;

  /**
   * Full-permutation reorder with trip-level If-Match lock.
   * sortKey = (index+1)*1000; bump trip version first; update items in chunks of ≤25.
   */
  readonly reorderItems: (
    ownerId: string,
    tripId: string,
    expectedTripVersion: number,
    itemIds: readonly string[],
  ) => Effect.Effect<ReorderItemsResult, AppError>;
}

export class TripRepo extends Context.Tag("TripRepo")<
  TripRepo,
  TripRepository
>() {}

function isVisibleToOwner(trip: Trip): boolean {
  return trip.status === "active";
}

function assertDateRange(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw AppError.validation("endDate must be on or after startDate");
  }
}

function newTripId(): string {
  return crypto.randomUUID();
}

function nowInstant(): string {
  return normalizeInstant(new Date().toISOString());
}

function sortItemsBySortKey(
  items: readonly ItineraryItem[],
): ItineraryItem[] {
  return [...items].sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      return a.sortKey - b.sortKey;
    }
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
}

function assertIdempotencyKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw AppError.validation("Idempotency-Key must not be empty");
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw AppError.validation(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * In-memory trip + item store for unit tests and interim runtime without TABLE_NAME.
 */
export function makeInMemoryTripRepo(
  seed: Iterable<Trip> = [],
  seedItems: Iterable<ItineraryItem> = [],
): TripRepository {
  const store = new Map<string, Trip>();
  /** tripId → itemId → item */
  const itemsByTrip = new Map<string, Map<string, ItineraryItem>>();
  /** ownerId\0idemKey → item snapshot (24h TTL simulated via map only) */
  const idempotency = new Map<string, ItineraryItem>();

  const tripKey = (ownerId: string, tripId: string) => `${ownerId}\0${tripId}`;
  const idemKey = (ownerId: string, key: string) => `${ownerId}\0${key}`;

  for (const trip of seed) {
    store.set(tripKey(trip.ownerId, trip.tripId), trip);
  }
  for (const item of seedItems) {
    let bucket = itemsByTrip.get(item.tripId);
    if (bucket === undefined) {
      bucket = new Map();
      itemsByTrip.set(item.tripId, bucket);
    }
    bucket.set(item.itemId, item);
  }

  const listOwnerActiveSorted = (ownerId: string): Trip[] => {
    const trips: Trip[] = [];
    for (const trip of store.values()) {
      if (trip.ownerId === ownerId && isVisibleToOwner(trip)) {
        trips.push(trip);
      }
    }
    // Stable order by tripId for deterministic cursors.
    trips.sort((a, b) =>
      a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0,
    );
    return trips;
  };

  const requireActiveTrip = (ownerId: string, tripId: string): Trip => {
    const trip = store.get(tripKey(ownerId, tripId));
    if (trip === undefined || !isVisibleToOwner(trip)) {
      throw AppError.notFound("Trip not found");
    }
    return trip;
  };

  const listItemsForTrip = (tripId: string): ItineraryItem[] => {
    const bucket = itemsByTrip.get(tripId);
    if (bucket === undefined) {
      return [];
    }
    return sortItemsBySortKey([...bucket.values()]);
  };

  return {
    create: (ownerId, input) =>
      Effect.try({
        try: () => {
          assertDateRange(input.startDate, input.endDate);
          const active = listOwnerActiveSorted(ownerId);
          if (active.length >= MAX_ACTIVE_TRIPS_PER_OWNER) {
            throw AppError.validation(
              `Active trip limit reached (max ${MAX_ACTIVE_TRIPS_PER_OWNER})`,
              { maxActiveTrips: MAX_ACTIVE_TRIPS_PER_OWNER },
            );
          }
          const trip: Trip = {
            tripId: newTripId(),
            ownerId,
            title: input.title,
            timezone: input.timezone,
            startDate: input.startDate,
            endDate: input.endDate,
            version: 1,
            status: "active",
          };
          store.set(tripKey(ownerId, trip.tripId), trip);
          return trip;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    getActiveForOwner: (ownerId, tripId) =>
      Effect.sync(() => {
        const trip = store.get(tripKey(ownerId, tripId));
        if (trip === undefined || !isVisibleToOwner(trip)) {
          return undefined;
        }
        return trip;
      }),

    listActiveForOwner: (ownerId, options) =>
      Effect.try({
        try: () => {
          const limit = options.limit ?? TRIP_LIST_PAGE_SIZE;
          if (limit < 1 || limit > TRIP_LIST_PAGE_SIZE) {
            throw AppError.validation(
              `limit must be between 1 and ${TRIP_LIST_PAGE_SIZE}`,
            );
          }
          const all = listOwnerActiveSorted(ownerId);
          let start = 0;
          if (options.cursor !== undefined && options.cursor.length > 0) {
            const idx = all.findIndex((t) => t.tripId === options.cursor);
            if (idx < 0) {
              throw AppError.validation("Invalid cursor");
            }
            start = idx + 1;
          }
          const page = all.slice(start, start + limit);
          const last = page[page.length - 1];
          const hasMore = start + page.length < all.length;
          return {
            trips: page,
            nextCursor:
              hasMore && last !== undefined ? last.tripId : undefined,
          };
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    update: (ownerId, tripId, expectedVersion, patch) =>
      Effect.try({
        try: () => {
          const existing = store.get(tripKey(ownerId, tripId));
          if (existing === undefined || !isVisibleToOwner(existing)) {
            throw AppError.notFound("Trip not found");
          }
          if (existing.version !== expectedVersion) {
            throw AppError.conflict("Version mismatch", {
              version: existing.version,
            });
          }
          const startDate = patch.startDate ?? existing.startDate;
          const endDate = patch.endDate ?? existing.endDate;
          assertDateRange(startDate, endDate);
          const updated: Trip = {
            ...existing,
            title: patch.title ?? existing.title,
            timezone: patch.timezone ?? existing.timezone,
            startDate,
            endDate,
            version: existing.version + 1,
          };
          store.set(tripKey(ownerId, tripId), updated);
          return updated;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    softDelete: (ownerId, tripId) =>
      Effect.try({
        try: () => {
          const existing = store.get(tripKey(ownerId, tripId));
          if (existing === undefined || !isVisibleToOwner(existing)) {
            throw AppError.notFound("Trip not found");
          }
          const deleted: Trip = {
            ...existing,
            status: "deleted",
            deletedAt: nowInstant(),
            version: existing.version + 1,
          };
          store.set(tripKey(ownerId, tripId), deleted);
          return deleted;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    listItems: (ownerId, tripId) =>
      Effect.try({
        try: () => {
          requireActiveTrip(ownerId, tripId);
          return listItemsForTrip(tripId);
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    getItem: (ownerId, tripId, itemId) =>
      Effect.try({
        try: () => {
          requireActiveTrip(ownerId, tripId);
          const bucket = itemsByTrip.get(tripId);
          return bucket?.get(itemId);
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    createItem: (ownerId, tripId, input, options) =>
      Effect.try({
        try: () => {
          requireActiveTrip(ownerId, tripId);
          const key = assertIdempotencyKey(options?.idempotencyKey);
          if (key !== undefined) {
            const cached = idempotency.get(idemKey(ownerId, key));
            if (cached !== undefined && cached.tripId === tripId) {
              return cached;
            }
          }

          const existing = listItemsForTrip(tripId);
          if (existing.length >= MAX_ITEMS_PER_TRIP) {
            throw AppError.validation(
              `Item limit reached (max ${MAX_ITEMS_PER_TRIP} per trip)`,
              { maxItems: MAX_ITEMS_PER_TRIP },
            );
          }
          const sortKey = nextAppendSortKey(existing.map((i) => i.sortKey));
          const item = buildCreatedItem(tripId, input, sortKey);
          let bucket = itemsByTrip.get(tripId);
          if (bucket === undefined) {
            bucket = new Map();
            itemsByTrip.set(tripId, bucket);
          }
          bucket.set(item.itemId, item);
          if (key !== undefined) {
            idempotency.set(idemKey(ownerId, key), item);
          }
          return item;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    updateItem: (ownerId, tripId, itemId, expectedVersion, patch) =>
      Effect.try({
        try: () => {
          requireActiveTrip(ownerId, tripId);
          const bucket = itemsByTrip.get(tripId);
          const existing = bucket?.get(itemId);
          if (existing === undefined) {
            throw AppError.notFound("Item not found");
          }
          if (existing.version !== expectedVersion) {
            throw AppError.conflict("Version mismatch", {
              version: existing.version,
            });
          }
          const updated = applyItemPatch(existing, patch);
          if (bucket === undefined) {
            throw AppError.notFound("Item not found");
          }
          bucket.set(itemId, updated);
          return updated;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    deleteItem: (ownerId, tripId, itemId) =>
      Effect.try({
        try: () => {
          requireActiveTrip(ownerId, tripId);
          const bucket = itemsByTrip.get(tripId);
          if (bucket === undefined || !bucket.has(itemId)) {
            throw AppError.notFound("Item not found");
          }
          bucket.delete(itemId);
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    reorderItems: (ownerId, tripId, expectedTripVersion, itemIds) =>
      Effect.try({
        try: () => {
          const trip = requireActiveTrip(ownerId, tripId);
          if (trip.version !== expectedTripVersion) {
            throw AppError.conflict("Version mismatch", {
              version: trip.version,
            });
          }
          const current = listItemsForTrip(tripId);
          const currentIds = new Set(current.map((i) => i.itemId));
          if (!isFullPermutation(itemIds, currentIds)) {
            throw AppError.validation(
              "itemIds must be a full permutation of the trip's items",
            );
          }

          // Trip-level lock: bump version first.
          const bumped: Trip = {
            ...trip,
            version: trip.version + 1,
          };
          store.set(tripKey(ownerId, tripId), bumped);

          const assignments = computeReorderSortKeys(itemIds);
          const bucket = itemsByTrip.get(tripId);
          if (bucket === undefined) {
            return { trip: bumped, items: [] };
          }
          const now = nowInstant();
          // Chunked updates (≤25) — sequential in memory for parity with Dynamo.
          for (const chunk of chunkArray(assignments, REORDER_CHUNK_SIZE)) {
            for (const { itemId, sortKey } of chunk) {
              const item = bucket.get(itemId);
              if (item === undefined) {
                throw AppError.internal();
              }
              bucket.set(itemId, {
                ...item,
                sortKey,
                updatedAt: now,
              });
            }
          }

          return {
            trip: bumped,
            items: listItemsForTrip(tripId),
          };
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),
  };
}
