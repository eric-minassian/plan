import {
  CreateItineraryItem,
  UpdateItineraryItem,
  type ItineraryItem,
  type Trip,
} from "@tripplan/domain";
import { Effect, Either, Schema as S } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import { AppError } from "../errors/app-error.js";
import {
  decodeJsonBody,
  etagFromVersion,
  parseIfMatchVersion,
} from "../http/decode.js";
import { RequestContext } from "../http/request-context.js";
import { getHeader, jsonResponse, type HttpResponse } from "../http/types.js";
import type { AttachmentRepo } from "../repos/attachment-repo.js";
import { MAX_ITEMS_PER_TRIP, TripRepo } from "../repos/trip-repo.js";
import type { DocsStore } from "../s3/docs-store.js";
import { cascadeDeleteItemAttachments } from "./attachments.js";

const ReorderBody = S.Struct({
  itemIds: S.Array(S.String),
});

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

function rejectExpectedVersionInBody(
  body: string | undefined,
): Effect.Effect<void, AppError> {
  if (body === undefined || body.trim().length === 0) {
    return Effect.void;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return Effect.fail(AppError.validation("Invalid JSON body"));
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "expectedVersion" in raw
  ) {
    return Effect.fail(
      AppError.validation(
        "expectedVersion in body is not allowed; use If-Match header",
      ),
    );
  }
  return Effect.void;
}

function itemJsonResponse(
  status: number,
  item: ItineraryItem,
): HttpResponse {
  return jsonResponse(status, item, {
    etag: etagFromVersion(item.version),
  });
}

/** POST /api/v1/trips/:tripId/items — create item (optional Idempotency-Key). */
export function handleCreateItem(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");

    const decoded = decodeJsonBody(CreateItineraryItem, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    const idempotencyKey = getHeader(request.headers, "idempotency-key");
    const item = yield* trips.createItem(
      principal.sub,
      tripId,
      decoded.right,
      idempotencyKey !== undefined ? { idempotencyKey } : undefined,
    );
    return itemJsonResponse(201, item);
  });
}

/** PATCH /api/v1/trips/:tripId/items/:itemId — If-Match on item version. */
export function handlePatchItem(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");

    yield* rejectExpectedVersionInBody(request.body);

    const ifMatch = getHeader(request.headers, "if-match");
    const versionResult = parseIfMatchVersion(ifMatch);
    if (Either.isLeft(versionResult)) {
      return yield* Effect.fail(versionResult.left);
    }

    const decoded = decodeJsonBody(UpdateItineraryItem, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    const patch = decoded.right;
    const hasField =
      patch.title !== undefined ||
      patch.startAt !== undefined ||
      patch.endAt !== undefined ||
      patch.startTimeZone !== undefined ||
      patch.endTimeZone !== undefined ||
      patch.startLocation !== undefined ||
      patch.endLocation !== undefined ||
      patch.notes !== undefined ||
      patch.confirmationCode !== undefined ||
      patch.enrichment !== undefined ||
      patch.details !== undefined;
    if (!hasField) {
      return yield* Effect.fail(
        AppError.validation("At least one field is required to update"),
      );
    }

    const item = yield* trips.updateItem(
      principal.sub,
      tripId,
      itemId,
      versionResult.right,
      patch,
    );
    return itemJsonResponse(200, item);
  });
}

/**
 * DELETE /api/v1/trips/:tripId/items/:itemId
 * Authorize ownership first, then cascade attachments (DDB+S3), then item row.
 * Never cascade before ownership — ATT rows are not owner-scoped keys.
 */
export function handleDeleteItem(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");
    // Fail closed: ownership/item existence before any ATT or S3 mutation.
    const item = yield* trips.getItem(principal.sub, tripId, itemId);
    if (item === undefined) {
      return yield* Effect.fail(AppError.notFound("Item not found"));
    }
    yield* cascadeDeleteItemAttachments(tripId, itemId);
    yield* trips.deleteItem(principal.sub, tripId, itemId);
    return { status: 204 };
  });
}

/**
 * POST /api/v1/trips/:tripId/items/reorder
 * Body `{ itemIds }`; If-Match on **trip** version.
 */
export function handleReorderItems(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");

    yield* rejectExpectedVersionInBody(request.body);

    const ifMatch = getHeader(request.headers, "if-match");
    const versionResult = parseIfMatchVersion(ifMatch);
    if (Either.isLeft(versionResult)) {
      return yield* Effect.fail(versionResult.left);
    }

    const decoded = decodeJsonBody(ReorderBody, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    // Cheap reject before loading the trip item set.
    if (decoded.right.itemIds.length > MAX_ITEMS_PER_TRIP) {
      return yield* Effect.fail(
        AppError.validation(
          `itemIds length exceeds max items per trip (${MAX_ITEMS_PER_TRIP})`,
        ),
      );
    }

    const result = yield* trips.reorderItems(
      principal.sub,
      tripId,
      versionResult.right,
      decoded.right.itemIds,
    );

    const body = {
      ...result.trip,
      items: result.items,
    };
    return jsonResponse(200, body, {
      etag: etagFromVersion(result.trip.version),
    });
  });
}

/** Response shape helper for OpenAPI-aligned tests. */
export type TripWithItems = Trip & { readonly items: readonly ItineraryItem[] };
