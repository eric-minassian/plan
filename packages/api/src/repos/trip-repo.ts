import type { CreateTrip, Trip, UpdateTrip } from "@tripplan/domain";
import { normalizeInstant } from "@tripplan/domain";
import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";

/** Hard quota: active (non-deleted) trips per owner. */
export const MAX_ACTIVE_TRIPS_PER_OWNER = 100;

/** Default page size for list owned trips. */
export const TRIP_LIST_PAGE_SIZE = 50;

export interface ListTripsResult {
  readonly trips: readonly Trip[];
  readonly nextCursor: string | undefined;
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

/**
 * In-memory trip store for unit tests and interim runtime without TABLE_NAME.
 */
export function makeInMemoryTripRepo(
  seed: Iterable<Trip> = [],
): TripRepository {
  const store = new Map<string, Trip>();

  const key = (ownerId: string, tripId: string) => `${ownerId}\0${tripId}`;

  for (const trip of seed) {
    store.set(key(trip.ownerId, trip.tripId), trip);
  }

  const listOwnerActiveSorted = (ownerId: string): Trip[] => {
    const trips: Trip[] = [];
    for (const trip of store.values()) {
      if (trip.ownerId === ownerId && isVisibleToOwner(trip)) {
        trips.push(trip);
      }
    }
    // Stable order by tripId for deterministic cursors.
    trips.sort((a, b) => (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0));
    return trips;
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
          store.set(key(ownerId, trip.tripId), trip);
          return trip;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    getActiveForOwner: (ownerId, tripId) =>
      Effect.sync(() => {
        const trip = store.get(key(ownerId, tripId));
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
            nextCursor: hasMore && last !== undefined ? last.tripId : undefined,
          };
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    update: (ownerId, tripId, expectedVersion, patch) =>
      Effect.try({
        try: () => {
          const existing = store.get(key(ownerId, tripId));
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
          store.set(key(ownerId, tripId), updated);
          return updated;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    softDelete: (ownerId, tripId) =>
      Effect.try({
        try: () => {
          const existing = store.get(key(ownerId, tripId));
          if (existing === undefined || !isVisibleToOwner(existing)) {
            throw AppError.notFound("Trip not found");
          }
          const deleted: Trip = {
            ...existing,
            status: "deleted",
            deletedAt: nowInstant(),
            version: existing.version + 1,
          };
          store.set(key(ownerId, tripId), deleted);
          return deleted;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),
  };
}
