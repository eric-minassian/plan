import {
  CreateTrip,
  UpdateTrip,
  type ItineraryItem,
  type Trip,
} from "@tripplan/domain";
import { Effect, Either, Schema as S } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import type { ApiConfig } from "../config.js";
import { ErrorCode } from "@tripplan/domain";
import { AppError } from "../errors/app-error.js";
import {
  decodeJsonBody,
  etagFromVersion,
  parseIfMatchVersion,
} from "../http/decode.js";
import { RequestContext } from "../http/request-context.js";
import { getHeader, jsonResponse, type HttpResponse } from "../http/types.js";
import { consoleLogger } from "../logging/logger.js";
import { TripRepo, TRIP_LIST_PAGE_SIZE } from "../repos/trip-repo.js";
import { TripDeleteQueue } from "../sqs/trip-delete-queue.js";

/** Owner trip GET/export payload: meta + items ordered by sortKey. */
export interface TripDetailResponse extends Trip {
  readonly items: readonly ItineraryItem[];
}

export interface TripListResponse {
  readonly trips: readonly Trip[];
  readonly nextCursor?: string;
}

function tripJsonResponse(
  status: number,
  trip: Trip,
  extras?: { readonly items?: readonly ItineraryItem[] },
): HttpResponse {
  const body =
    extras?.items !== undefined
      ? { ...trip, items: extras.items }
      : trip;
  return jsonResponse(status, body, {
    etag: etagFromVersion(trip.version),
  });
}

function requirePathParam(
  params: Readonly<Record<string, string>>,
  name: string,
): Effect.Effect<string, AppError> {
  const value = params[name];
  if (value === undefined || value.length === 0) {
    return Effect.fail(AppError.validation(`Missing path parameter: ${name}`));
  }
  return Effect.succeed(value);
}

/** POST /api/v1/trips — create trip (owner). */
export function handleCreateTrip(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request } = yield* RequestContext;
    const decoded = decodeJsonBody(CreateTrip, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }
    const trip = yield* trips.create(principal.sub, decoded.right);
    return tripJsonResponse(201, trip);
  });
}

/** GET /api/v1/trips — list owned active trips (cursor, page size 50). */
export function handleListTrips(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request } = yield* RequestContext;
    const cursor = request.query.cursor;
    const limitRaw = request.query.limit;
    let limit = TRIP_LIST_PAGE_SIZE;
    if (limitRaw !== undefined && limitRaw.length > 0) {
      if (!/^\d+$/.test(limitRaw)) {
        return yield* Effect.fail(
          AppError.validation("limit must be a positive integer"),
        );
      }
      limit = Number(limitRaw);
    }
    const result = yield* trips.listActiveForOwner(principal.sub, {
      limit,
      cursor,
    });
    const body: TripListResponse = {
      trips: result.trips,
      ...(result.nextCursor !== undefined
        ? { nextCursor: result.nextCursor }
        : {}),
    };
    return jsonResponse(200, body);
  });
}

/** GET /api/v1/trips/:tripId — trip meta + items ordered by sortKey. */
export function handleGetTrip(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const trip = yield* trips.getActiveForOwner(principal.sub, tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.notFound("Trip not found"));
    }
    // Skip second meta Get — ownership already verified above.
    const items = yield* trips.listItems(principal.sub, tripId, {
      tripAlreadyVerified: true,
    });
    return tripJsonResponse(200, trip, { items });
  });
}

/** GET /api/v1/trips/:tripId/export — export JSON (meta + items). */
export function handleExportTrip(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const trip = yield* trips.getActiveForOwner(principal.sub, tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.notFound("Trip not found"));
    }
    const items = yield* trips.listItems(principal.sub, tripId, {
      tripAlreadyVerified: true,
    });
    const payload: TripDetailResponse = { ...trip, items };
    return jsonResponse(200, payload, {
      etag: etagFromVersion(trip.version),
      "content-disposition": `attachment; filename="trip-${trip.tripId}.json"`,
    });
  });
}

/** PATCH /api/v1/trips/:tripId — If-Match required; reject body expectedVersion. */
export function handlePatchTrip(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");

    if (request.body !== undefined && request.body.trim().length > 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(request.body) as unknown;
      } catch {
        return yield* Effect.fail(AppError.validation("Invalid JSON body"));
      }
      if (
        raw !== null &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        "expectedVersion" in raw
      ) {
        return yield* Effect.fail(
          AppError.validation(
            "expectedVersion in body is not allowed; use If-Match header",
          ),
        );
      }
    }

    const ifMatch = getHeader(request.headers, "if-match");
    const versionResult = parseIfMatchVersion(ifMatch);
    if (Either.isLeft(versionResult)) {
      return yield* Effect.fail(versionResult.left);
    }

    const decoded = decodeJsonBody(UpdateTrip, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }
    // At least one field should be present for a meaningful patch.
    const patch = decoded.right;
    if (
      patch.title === undefined &&
      patch.timezone === undefined &&
      patch.startDate === undefined &&
      patch.endDate === undefined
    ) {
      return yield* Effect.fail(
        AppError.validation("At least one field is required to update"),
      );
    }

    const trip = yield* trips.update(
      principal.sub,
      tripId,
      versionResult.right,
      patch,
    );
    return tripJsonResponse(200, trip);
  });
}

/**
 * DELETE /api/v1/trips/:tripId — mark status=deleting, enqueue SQS cascade.
 * Feature flag `tripsDeleteEnabled` (default on). Returns 200 `{ status: "deleting" }`.
 * Idempotent while already deleting (re-enqueues worker).
 *
 * markDeleting + enqueue is not atomic: if enqueue fails after the Dynamo
 * update, the trip is already non-listable (`deleting`). Clients should
 * **retry DELETE** (idempotent re-enqueue). Structured log:
 * `markDeletingSucceeded enqueueFailed`.
 */
export function handleDeleteTrip(
  config: Pick<ApiConfig, "tripsDeleteEnabled">,
): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | TripDeleteQueue | RequestContext
> {
  return Effect.gen(function* () {
    if (!config.tripsDeleteEnabled) {
      return yield* Effect.fail(
        AppError.forbidden("Trip delete is disabled"),
      );
    }
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const queue = yield* TripDeleteQueue;
    const { pathParams, request } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const trip = yield* trips.markDeleting(principal.sub, tripId);

    const enqueued = yield* Effect.either(
      queue.enqueue({
        tripId: trip.tripId,
        ownerId: principal.sub,
      }),
    );
    if (Either.isLeft(enqueued)) {
      // Trip is already deleting — client must retry DELETE to re-enqueue.
      consoleLogger.log("error", "markDeletingSucceeded enqueueFailed", {
        tripId: trip.tripId,
        requestId: request.requestId,
        recovery: "retry_delete",
      });
      return yield* Effect.fail(
        new AppError({
          type: ErrorCode.InternalError,
          message:
            "Trip marked deleting but cascade enqueue failed; retry DELETE",
          retryable: true,
          details: {
            tripId: trip.tripId,
            status: "deleting",
            recovery: "retry_delete",
          },
        }),
      );
    }

    return jsonResponse(200, {
      tripId: trip.tripId,
      status: "deleting" as const,
      deletedAt: trip.deletedAt,
      version: trip.version,
    });
  });
}

/** Bind config into a zero-arg handler for the router table. */
export function makeDeleteTripHandler(
  config: Pick<ApiConfig, "tripsDeleteEnabled">,
): () => Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | TripDeleteQueue | RequestContext
> {
  return () => handleDeleteTrip(config);
}

/** Type-only re-export helper for tests. */
export const TripDetailSchema = S.Struct({
  tripId: S.String,
  ownerId: S.String,
  title: S.String,
  timezone: S.String,
  startDate: S.String,
  endDate: S.String,
  version: S.Number,
  status: S.Literal("active", "deleting", "deleted"),
  items: S.Array(S.Unknown),
});
