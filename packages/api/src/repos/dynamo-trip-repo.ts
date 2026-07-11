import type { ItineraryItem, Trip } from "@tripplan/domain";
import { normalizeInstant } from "@tripplan/domain";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import { Effect, Either } from "effect";
import { AppError, internalFromCause } from "../errors/app-error.js";
import {
  buildCreatedItem,
  buildItemPatchUpdateExpression,
} from "./item-build.js";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ITEMS_PER_TRIP,
  REORDER_CHUNK_SIZE,
  chunkArray,
  computeReorderSortKeys,
  isFullPermutation,
  nextAppendSortKey,
} from "./reorder.js";
import {
  MAX_ACTIVE_TRIPS_PER_OWNER,
  TRIP_LIST_PAGE_SIZE,
  type ListTripsResult,
  type ReorderItemsResult,
  type TripRepository,
} from "./trip-repo.js";

/** Soft-delete meta retention (Dynamo TTL epoch offset from markDeleting). */
export const TRIP_SOFT_DELETE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Dynamo single-table trip meta item (PK/SK + GSI1 + domain attrs). */
export interface TripItem {
  readonly PK: string;
  readonly SK: string;
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly entityType: "TRIP";
  readonly tripId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly version: number;
  readonly status: "active" | "deleting" | "deleted";
  readonly deletedAt?: string;
  /** Dynamo TTL (epoch seconds) — set on markDeleting for 30-day meta purge. */
  readonly ttl?: number;
}

/**
 * Dynamo itinerary item row.
 * PK=TRIP#tripId, SK=ITEM#itemId (immutable identity — never encode sortKey in SK).
 * ownerId denormalized for authz without extra hops.
 */
export interface DynamoItineraryItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: "ITEM";
  readonly ownerId: string;
  readonly itemId: string;
  readonly tripId: string;
  readonly type: ItineraryItem["type"];
  readonly title: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly startTimeZone?: string;
  readonly endTimeZone?: string;
  readonly startLocation?: ItineraryItem["startLocation"];
  readonly endLocation?: ItineraryItem["endLocation"];
  readonly notes?: string;
  readonly confirmationCode?: string;
  readonly sortKey: number;
  readonly version: number;
  readonly enrichment?: ItineraryItem["enrichment"];
  readonly details: ItineraryItem["details"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Idempotency claim for POST items (TTL 24h).
 * Stores itemId + completed flag — replay re-reads the live item (not a snapshot).
 * completed=true + missing item → 404 (delete after create); completed=false → finish create.
 */
export interface IdempotencyItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: "IDEM";
  readonly tripId: string;
  readonly itemId: string;
  /** true once the item Put succeeded */
  readonly completed: boolean;
  readonly ttl: number;
}

export function userPk(ownerId: string): string {
  return `USER#${ownerId}`;
}

export function tripSk(tripId: string): string {
  return `TRIP#${tripId}`;
}

export function tripItemsPk(tripId: string): string {
  return `TRIP#${tripId}`;
}

export function itemSk(itemId: string): string {
  return `ITEM#${itemId}`;
}

export function idemPk(ownerId: string): string {
  return `IDEM#${ownerId}`;
}

export function idemSk(key: string): string {
  return `KEY#${key}`;
}

function gsi1Pk(tripId: string): string {
  return `TRIP#${tripId}`;
}

function isVisibleStatus(status: string): boolean {
  return status === "active";
}

export function itemToTrip(item: TripItem): Trip {
  const trip: Trip = {
    tripId: item.tripId,
    ownerId: item.ownerId,
    title: item.title,
    timezone: item.timezone as Trip["timezone"],
    startDate: item.startDate as Trip["startDate"],
    endDate: item.endDate as Trip["endDate"],
    version: item.version,
    status: item.status,
  };
  if (item.deletedAt !== undefined) {
    return { ...trip, deletedAt: item.deletedAt as Trip["deletedAt"] };
  }
  return trip;
}

/** Map Dynamo ITEM row → domain ItineraryItem (drops PK/SK/ownerId). */
export function dynamoItemToDomain(row: DynamoItineraryItem): ItineraryItem {
  const base = {
    itemId: row.itemId,
    tripId: row.tripId,
    title: row.title,
    sortKey: row.sortKey,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.startAt !== undefined ? { startAt: row.startAt } : {}),
    ...(row.endAt !== undefined ? { endAt: row.endAt } : {}),
    ...(row.startTimeZone !== undefined
      ? { startTimeZone: row.startTimeZone }
      : {}),
    ...(row.endTimeZone !== undefined
      ? { endTimeZone: row.endTimeZone }
      : {}),
    ...(row.startLocation !== undefined
      ? { startLocation: row.startLocation }
      : {}),
    ...(row.endLocation !== undefined
      ? { endLocation: row.endLocation }
      : {}),
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
    ...(row.confirmationCode !== undefined
      ? { confirmationCode: row.confirmationCode }
      : {}),
    ...(row.enrichment !== undefined ? { enrichment: row.enrichment } : {}),
  };

  switch (row.type) {
    case "flight":
      return {
        ...base,
        type: "flight",
        details: row.details as Extract<ItineraryItem, { type: "flight" }>["details"],
      };
    case "train":
      return {
        ...base,
        type: "train",
        details: row.details as Extract<ItineraryItem, { type: "train" }>["details"],
      };
    case "hotel":
      return {
        ...base,
        type: "hotel",
        details: row.details as Extract<ItineraryItem, { type: "hotel" }>["details"],
      };
    case "transport":
      return {
        ...base,
        type: "transport",
        details: row.details as Extract<
          ItineraryItem,
          { type: "transport" }
        >["details"],
      };
    case "activity":
      return {
        ...base,
        type: "activity",
        details: row.details as Extract<
          ItineraryItem,
          { type: "activity" }
        >["details"],
      };
    case "ticket":
      return {
        ...base,
        type: "ticket",
        details: row.details as Extract<ItineraryItem, { type: "ticket" }>["details"],
      };
    case "note":
      return {
        ...base,
        type: "note",
        details: row.details as Extract<ItineraryItem, { type: "note" }>["details"],
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        details: row.details as Extract<ItineraryItem, { type: "custom" }>["details"],
      };
  }
}

export function domainItemToDynamo(
  ownerId: string,
  item: ItineraryItem,
): DynamoItineraryItem {
  return {
    PK: tripItemsPk(item.tripId),
    SK: itemSk(item.itemId),
    entityType: "ITEM",
    ownerId,
    itemId: item.itemId,
    tripId: item.tripId,
    type: item.type,
    title: item.title,
    ...(item.startAt !== undefined ? { startAt: item.startAt } : {}),
    ...(item.endAt !== undefined ? { endAt: item.endAt } : {}),
    ...(item.startTimeZone !== undefined
      ? { startTimeZone: item.startTimeZone }
      : {}),
    ...(item.endTimeZone !== undefined
      ? { endTimeZone: item.endTimeZone }
      : {}),
    ...(item.startLocation !== undefined
      ? { startLocation: item.startLocation }
      : {}),
    ...(item.endLocation !== undefined
      ? { endLocation: item.endLocation }
      : {}),
    ...(item.notes !== undefined ? { notes: item.notes } : {}),
    ...(item.confirmationCode !== undefined
      ? { confirmationCode: item.confirmationCode }
      : {}),
    sortKey: item.sortKey,
    version: item.version,
    ...(item.enrichment !== undefined ? { enrichment: item.enrichment } : {}),
    details: item.details,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function requireDateRange(
  startDate: string,
  endDate: string,
): Effect.Effect<void, AppError> {
  if (endDate < startDate) {
    return Effect.fail(
      AppError.validation("endDate must be on or after startDate"),
    );
  }
  return Effect.void;
}

/** Encode ExclusiveStartKey-style cursor (PK/SK of last returned item). */
export function encodeCursor(
  key: Record<string, NativeAttributeValue>,
): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Decode + validate list cursor for an owner partition.
 * Cursor must be `{ PK: USER#ownerId, SK: TRIP#... }`.
 */
export function parseListCursor(
  cursor: string,
  ownerId: string,
): Record<string, NativeAttributeValue> {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw AppError.validation("Invalid cursor");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw AppError.validation("Invalid cursor");
  }
  const record = parsed as Record<string, unknown>;
  const pk = record.PK;
  const sk = record.SK;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw AppError.validation("Invalid cursor");
  }
  if (pk !== userPk(ownerId) || !sk.startsWith("TRIP#") || sk.length <= 5) {
    throw AppError.validation("Invalid cursor");
  }
  return { PK: pk, SK: sk };
}

function isDynamoValidationException(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { name: string }).name === "ValidationException"
  );
}

function mapDynamoError(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, { component: "dynamo-trip-repo" });
}

function cursorFromItem(item: TripItem): string {
  return encodeCursor({ PK: item.PK, SK: item.SK });
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
 * Page active trips from Query results without dropping mid-page matches.
 *
 * When the page fills mid-`Items` array, nextCursor is the last **returned**
 * item's PK/SK (not Dynamo LastEvaluatedKey, which would skip remainder).
 * When the page fills exactly at end of a batch and LEK exists, use LEK.
 * When LEK is absent but unconsumed matching items remain, still emit cursor
 * from last returned item.
 */
export function accumulateActivePage(input: {
  readonly limit: number;
  readonly batches: readonly {
    readonly items: readonly TripItem[];
    readonly lastEvaluatedKey:
      | Record<string, NativeAttributeValue>
      | undefined;
  }[];
}): ListTripsResult {
  const trips: Trip[] = [];
  let nextCursor: string | undefined;

  for (const batch of input.batches) {
    let consumed = 0;
    for (const item of batch.items) {
      if (trips.length >= input.limit) {
        break;
      }
      trips.push(itemToTrip(item));
      consumed += 1;
    }

    if (trips.length >= input.limit) {
      if (consumed < batch.items.length) {
        // Mid-page: residual matches in this batch must not be skipped.
        const last = batch.items[consumed - 1];
        if (last !== undefined) {
          nextCursor = cursorFromItem(last);
        }
      } else if (batch.lastEvaluatedKey !== undefined) {
        nextCursor = encodeCursor(batch.lastEvaluatedKey);
      } else {
        nextCursor = undefined;
      }
      break;
    }

    if (batch.lastEvaluatedKey === undefined) {
      nextCursor = undefined;
      break;
    }
    // Continue to next batch (caller feeds sequential batches).
  }

  return { trips, nextCursor };
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * DynamoDB single-table TripRepository (trips + itinerary items).
 * Trip: PK=USER#ownerId SK=TRIP#tripId; GSI1PK=TRIP#tripId GSI1SK=META.
 * Item: PK=TRIP#tripId SK=ITEM#itemId; sortKey attribute (never in SK).
 *
 * Active-trip quota (100) is check-then-act (**best-effort** under concurrent
 * creates). Soft-deleted rows do not count. Atomic counter deferred post-v1.
 */
export function makeDynamoTripRepo(
  tableName: string,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({}),
  ),
): TripRepository {
  const getTripItem = (
    ownerId: string,
    tripId: string,
  ): Effect.Effect<TripItem | undefined, AppError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
          }),
        );
        if (result.Item === undefined) {
          return undefined;
        }
        return result.Item as TripItem;
      },
      catch: mapDynamoError,
    });

  const requireActiveTrip = (
    ownerId: string,
    tripId: string,
  ): Effect.Effect<Trip, AppError> =>
    Effect.gen(function* () {
      const item = yield* getTripItem(ownerId, tripId);
      if (item === undefined || !isVisibleStatus(item.status)) {
        return yield* Effect.fail(AppError.notFound("Trip not found"));
      }
      return itemToTrip(item);
    });

  const queryAllItems = (
    tripId: string,
  ): Effect.Effect<ItineraryItem[], AppError> =>
    Effect.tryPromise({
      try: async () => {
        const collected: ItineraryItem[] = [];
        let exclusiveStartKey:
          | Record<string, NativeAttributeValue>
          | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
              ExpressionAttributeValues: {
                ":pk": tripItemsPk(tripId),
                ":sk": "ITEM#",
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          for (const raw of result.Items ?? []) {
            collected.push(dynamoItemToDomain(raw as DynamoItineraryItem));
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
        return sortItemsBySortKey(collected);
      },
      catch: mapDynamoError,
    });

  const getDynamoItem = (
    tripId: string,
    itemId: string,
  ): Effect.Effect<DynamoItineraryItem | undefined, AppError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { PK: tripItemsPk(tripId), SK: itemSk(itemId) },
          }),
        );
        if (result.Item === undefined) {
          return undefined;
        }
        return result.Item as DynamoItineraryItem;
      },
      catch: mapDynamoError,
    });

  /**
   * COUNT active trips in owner partition.
   * Cost grows with historical soft-deleted metas until cascade purge (PR 15);
   * acceptable for dogfood at ≤100 actives.
   */
  const countActive = (ownerId: string): Effect.Effect<number, AppError> =>
    Effect.tryPromise({
      try: async () => {
        let count = 0;
        let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
              FilterExpression: "#status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pk": userPk(ownerId),
                ":sk": "TRIP#",
                ":active": "active",
              },
              Select: "COUNT",
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          count += result.Count ?? 0;
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
        return count;
      },
      catch: mapDynamoError,
    });

  const putItemSortKeysChunk = (
    tripId: string,
    assignments: readonly { itemId: string; sortKey: number }[],
    updatedAt: string,
  ): Effect.Effect<void, AppError> =>
    Effect.tryPromise({
      try: async () => {
        // Sequential UpdateItem within chunk (design: not one TransactWrite).
        for (const { itemId, sortKey } of assignments) {
          await client.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: tripItemsPk(tripId), SK: itemSk(itemId) },
              UpdateExpression: "SET sortKey = :sk, updatedAt = :ua",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: {
                ":sk": sortKey,
                ":ua": updatedAt,
              },
            }),
          );
        }
      },
      catch: mapDynamoError,
    });

  return {
    create: (ownerId, input) =>
      Effect.gen(function* () {
        yield* requireDateRange(input.startDate, input.endDate);
        const activeCount = yield* countActive(ownerId);
        if (activeCount >= MAX_ACTIVE_TRIPS_PER_OWNER) {
          return yield* Effect.fail(
            AppError.validation(
              `Active trip limit reached (max ${MAX_ACTIVE_TRIPS_PER_OWNER})`,
              { maxActiveTrips: MAX_ACTIVE_TRIPS_PER_OWNER },
            ),
          );
        }
        const tripId = crypto.randomUUID();
        const trip: Trip = {
          tripId,
          ownerId,
          title: input.title,
          timezone: input.timezone,
          startDate: input.startDate,
          endDate: input.endDate,
          version: 1,
          status: "active",
        };
        const item: TripItem = {
          PK: userPk(ownerId),
          SK: tripSk(tripId),
          GSI1PK: gsi1Pk(tripId),
          GSI1SK: "META",
          entityType: "TRIP",
          tripId,
          ownerId,
          title: trip.title,
          timezone: trip.timezone,
          startDate: trip.startDate,
          endDate: trip.endDate,
          version: 1,
          status: "active",
        };
        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new PutCommand({
                TableName: tableName,
                Item: item,
                ConditionExpression:
                  "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              }),
            ),
          catch: mapDynamoError,
        });
        return trip;
      }),

    getActiveForOwner: (ownerId, tripId) =>
      Effect.gen(function* () {
        const item = yield* getTripItem(ownerId, tripId);
        if (item === undefined || !isVisibleStatus(item.status)) {
          return undefined;
        }
        return itemToTrip(item);
      }),

    listActiveForOwner: (ownerId, options) =>
      Effect.tryPromise({
        try: async () => {
          const limit = options.limit ?? TRIP_LIST_PAGE_SIZE;
          if (limit < 1 || limit > TRIP_LIST_PAGE_SIZE) {
            throw AppError.validation(
              `limit must be between 1 and ${TRIP_LIST_PAGE_SIZE}`,
            );
          }

          let exclusiveStartKey:
            | Record<string, NativeAttributeValue>
            | undefined =
            options.cursor !== undefined && options.cursor.length > 0
              ? parseListCursor(options.cursor, ownerId)
              : undefined;

          const trips: Trip[] = [];
          let nextCursor: string | undefined;

          // FilterExpression applies after Limit; page until we fill `limit`
          // actives or exhaust the partition (access pattern 1).
          while (trips.length < limit) {
            const need = limit - trips.length;
            const result = await client.send(
              new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                FilterExpression: "#status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":pk": userPk(ownerId),
                  ":sk": "TRIP#",
                  ":active": "active",
                },
                // Over-fetch raw keys to compensate for filtered deleted rows.
                Limit: Math.max(need * 3, 10),
                ExclusiveStartKey: exclusiveStartKey,
              }),
            );

            const batchItems = (result.Items ?? []) as TripItem[];
            let consumed = 0;
            for (const raw of batchItems) {
              if (trips.length >= limit) {
                break;
              }
              trips.push(itemToTrip(raw));
              consumed += 1;
            }

            if (trips.length >= limit) {
              if (consumed < batchItems.length) {
                // Mid-batch residual: cursor at last returned item, not LEK.
                const lastReturned = batchItems[consumed - 1];
                nextCursor =
                  lastReturned !== undefined
                    ? cursorFromItem(lastReturned)
                    : undefined;
              } else if (result.LastEvaluatedKey !== undefined) {
                nextCursor = encodeCursor(result.LastEvaluatedKey);
              } else {
                nextCursor = undefined;
              }
              break;
            }

            if (result.LastEvaluatedKey === undefined) {
              nextCursor = undefined;
              break;
            }
            exclusiveStartKey = result.LastEvaluatedKey;
          }

          const out: ListTripsResult = { trips, nextCursor };
          return out;
        },
        catch: (cause) => {
          if (cause instanceof AppError) {
            return cause;
          }
          // Malformed ExclusiveStartKey after our shape check, or bad cursor.
          if (isDynamoValidationException(cause)) {
            return AppError.validation("Invalid cursor");
          }
          return mapDynamoError(cause);
        },
      }),

    update: (ownerId, tripId, expectedVersion, patch) =>
      Effect.gen(function* () {
        const existingItem = yield* getTripItem(ownerId, tripId);
        if (
          existingItem === undefined ||
          !isVisibleStatus(existingItem.status)
        ) {
          return yield* Effect.fail(AppError.notFound("Trip not found"));
        }
        const existing = itemToTrip(existingItem);
        if (existing.version !== expectedVersion) {
          return yield* Effect.fail(
            AppError.conflict("Version mismatch", {
              version: existing.version,
            }),
          );
        }
        const startDate = patch.startDate ?? existing.startDate;
        const endDate = patch.endDate ?? existing.endDate;
        yield* requireDateRange(startDate, endDate);
        const title = patch.title ?? existing.title;
        const timezone = patch.timezone ?? existing.timezone;
        const newVersion = existing.version + 1;

        const write = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                  UpdateExpression:
                    "SET title = :title, #tz = :tz, startDate = :sd, endDate = :ed, #ver = :nv",
                  ConditionExpression: "#ver = :ev AND #status = :active",
                  ExpressionAttributeNames: {
                    "#tz": "timezone",
                    "#ver": "version",
                    "#status": "status",
                  },
                  ExpressionAttributeValues: {
                    ":title": title,
                    ":tz": timezone,
                    ":sd": startDate,
                    ":ed": endDate,
                    ":nv": newVersion,
                    ":ev": expectedVersion,
                    ":active": "active",
                  },
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(write)) {
          const cause = write.left;
          if (cause instanceof ConditionalCheckFailedException) {
            // Re-Get current version so client If-Match is not stuck on stale.
            const live = yield* getTripItem(ownerId, tripId);
            if (live === undefined || !isVisibleStatus(live.status)) {
              return yield* Effect.fail(AppError.notFound("Trip not found"));
            }
            return yield* Effect.fail(
              AppError.conflict("Version mismatch", {
                version: live.version,
              }),
            );
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        return {
          ...existing,
          title,
          timezone,
          startDate,
          endDate,
          version: newVersion,
        } satisfies Trip;
      }),

    markDeleting: (ownerId, tripId) =>
      Effect.gen(function* () {
        const existingItem = yield* getTripItem(ownerId, tripId);
        if (existingItem === undefined || existingItem.status === "deleted") {
          return yield* Effect.fail(AppError.notFound("Trip not found"));
        }
        // Idempotent re-enqueue path when worker/API already set deleting.
        if (existingItem.status === "deleting") {
          return itemToTrip(existingItem);
        }
        const existing = itemToTrip(existingItem);
        const deletedAt = normalizeInstant(new Date().toISOString());
        const ttl =
          Math.floor(Date.now() / 1000) + TRIP_SOFT_DELETE_TTL_SECONDS;

        // Condition only on active status — DELETE is not If-Match-gated.
        // Bump version atomically so concurrent PATCH cannot race; CCF →
        // re-Get (concurrent delete may have moved to deleting).
        const write = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                  UpdateExpression:
                    "SET #status = :deleting, deletedAt = :da, #ver = #ver + :one, #ttl = :ttl",
                  ConditionExpression: "#status = :active",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#ver": "version",
                    "#ttl": "ttl",
                  },
                  ExpressionAttributeValues: {
                    ":deleting": "deleting",
                    ":active": "active",
                    ":da": deletedAt,
                    ":one": 1,
                    ":ttl": ttl,
                  },
                  ReturnValues: "ALL_NEW",
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(write)) {
          const cause = write.left;
          if (cause instanceof ConditionalCheckFailedException) {
            // Concurrent DELETE may have won — treat deleting as success.
            const live = yield* getTripItem(ownerId, tripId);
            if (live !== undefined && live.status === "deleting") {
              return itemToTrip(live);
            }
            return yield* Effect.fail(AppError.notFound("Trip not found"));
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        const attrs = write.right.Attributes as TripItem | undefined;
        if (attrs !== undefined) {
          return itemToTrip(attrs);
        }
        return {
          ...existing,
          status: "deleting" as const,
          deletedAt: deletedAt as Trip["deletedAt"],
          version: existing.version + 1,
        };
      }),

    markDeleted: (ownerId, tripId) =>
      Effect.gen(function* () {
        const existingItem = yield* getTripItem(ownerId, tripId);
        if (existingItem === undefined) {
          return yield* Effect.fail(AppError.notFound("Trip not found"));
        }
        const existing = itemToTrip(existingItem);
        const deletedAt =
          existingItem.deletedAt ??
          normalizeInstant(new Date().toISOString());
        // Ensure TTL exists even if meta was interim-deleted before PR 15
        // (status=deleted without ttl would otherwise retain forever).
        const ttl =
          existingItem.ttl ??
          Math.floor(Date.now() / 1000) + TRIP_SOFT_DELETE_TTL_SECONDS;

        // Pure no-op only when already deleted *and* ttl present.
        if (
          existingItem.status === "deleted" &&
          existingItem.ttl !== undefined
        ) {
          return existing;
        }

        // Already deleted but missing ttl (or deletedAt): backfill only.
        if (existingItem.status === "deleted") {
          const backfill = yield* Effect.either(
            Effect.tryPromise({
              try: () =>
                client.send(
                  new UpdateCommand({
                    TableName: tableName,
                    Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                    UpdateExpression: "SET deletedAt = :da, #ttl = :ttl",
                    ConditionExpression:
                      "attribute_exists(PK) AND #status = :deleted",
                    ExpressionAttributeNames: {
                      "#status": "status",
                      "#ttl": "ttl",
                    },
                    ExpressionAttributeValues: {
                      ":deleted": "deleted",
                      ":da": deletedAt,
                      ":ttl": ttl,
                    },
                    ReturnValues: "ALL_NEW",
                  }),
                ),
              catch: (cause) => cause,
            }),
          );
          if (Either.isLeft(backfill)) {
            const cause = backfill.left;
            if (cause instanceof ConditionalCheckFailedException) {
              const live = yield* getTripItem(ownerId, tripId);
              if (live !== undefined) {
                return itemToTrip(live);
              }
              return yield* Effect.fail(AppError.notFound("Trip not found"));
            }
            return yield* Effect.fail(mapDynamoError(cause));
          }
          const attrs = backfill.right.Attributes as TripItem | undefined;
          if (attrs !== undefined) {
            return itemToTrip(attrs);
          }
          return {
            ...existing,
            status: "deleted" as const,
            deletedAt: deletedAt as Trip["deletedAt"],
          };
        }

        const write = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                  UpdateExpression:
                    "SET #status = :deleted, deletedAt = :da, #ver = #ver + :one, #ttl = :ttl",
                  ConditionExpression:
                    "attribute_exists(PK) AND #status <> :deleted",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#ver": "version",
                    "#ttl": "ttl",
                  },
                  ExpressionAttributeValues: {
                    ":deleted": "deleted",
                    ":da": deletedAt,
                    ":one": 1,
                    ":ttl": ttl,
                  },
                  ReturnValues: "ALL_NEW",
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(write)) {
          const cause = write.left;
          if (cause instanceof ConditionalCheckFailedException) {
            // Concurrent finalize — re-Get; backfill ttl if still missing.
            const live = yield* getTripItem(ownerId, tripId);
            if (live === undefined) {
              return yield* Effect.fail(AppError.notFound("Trip not found"));
            }
            if (live.status === "deleted" && live.ttl === undefined) {
              // Recurse via same path by re-invoking logic: single Update for ttl.
              const ttlOnly = yield* Effect.either(
                Effect.tryPromise({
                  try: () =>
                    client.send(
                      new UpdateCommand({
                        TableName: tableName,
                        Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                        UpdateExpression: "SET deletedAt = :da, #ttl = :ttl",
                        ConditionExpression: "attribute_exists(PK)",
                        ExpressionAttributeNames: { "#ttl": "ttl" },
                        ExpressionAttributeValues: {
                          ":da":
                            live.deletedAt ??
                            normalizeInstant(new Date().toISOString()),
                          ":ttl":
                            Math.floor(Date.now() / 1000) +
                            TRIP_SOFT_DELETE_TTL_SECONDS,
                        },
                        ReturnValues: "ALL_NEW",
                      }),
                    ),
                  catch: (c) => c,
                }),
              );
              if (Either.isRight(ttlOnly)) {
                const a = ttlOnly.right.Attributes as TripItem | undefined;
                if (a !== undefined) {
                  return itemToTrip(a);
                }
              }
            }
            if (live.status === "deleted") {
              return itemToTrip(live);
            }
            return yield* Effect.fail(AppError.notFound("Trip not found"));
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        const attrs = write.right.Attributes as TripItem | undefined;
        if (attrs !== undefined) {
          return itemToTrip(attrs);
        }
        return {
          ...existing,
          status: "deleted" as const,
          deletedAt: deletedAt as Trip["deletedAt"],
          version: existing.version + 1,
        };
      }),

    listItems: (ownerId, tripId, options) =>
      Effect.gen(function* () {
        if (options?.tripAlreadyVerified !== true) {
          yield* requireActiveTrip(ownerId, tripId);
        }
        return yield* queryAllItems(tripId);
      }),

    getItem: (ownerId, tripId, itemId) =>
      Effect.gen(function* () {
        yield* requireActiveTrip(ownerId, tripId);
        const row = yield* getDynamoItem(tripId, itemId);
        if (row === undefined) {
          return undefined;
        }
        if (row.ownerId !== ownerId) {
          return undefined;
        }
        return dynamoItemToDomain(row);
      }),

    createItem: (ownerId, tripId, input, options) =>
      Effect.gen(function* () {
        yield* requireActiveTrip(ownerId, tripId);

        let idemKeyValue: string | undefined;
        try {
          idemKeyValue = assertIdempotencyKey(options?.idempotencyKey);
        } catch (e) {
          return yield* Effect.fail(
            e instanceof AppError ? e : AppError.internal(),
          );
        }

        const loadIdem = (
          key: string,
        ): Effect.Effect<IdempotencyItem | undefined, AppError> =>
          Effect.tryPromise({
            try: async () => {
              const result = await client.send(
                new GetCommand({
                  TableName: tableName,
                  Key: {
                    PK: idemPk(ownerId),
                    SK: idemSk(key),
                  },
                }),
              );
              return result.Item as IdempotencyItem | undefined;
            },
            catch: mapDynamoError,
          });

        if (idemKeyValue !== undefined) {
          const existingIdem = yield* loadIdem(idemKeyValue);
          if (existingIdem !== undefined) {
            if (existingIdem.tripId !== tripId) {
              return yield* Effect.fail(
                AppError.conflict(
                  "Idempotency-Key already used for a different trip",
                  { tripId: existingIdem.tripId },
                ),
              );
            }
            const row = yield* getDynamoItem(tripId, existingIdem.itemId);
            if (row !== undefined && row.ownerId === ownerId) {
              return dynamoItemToDomain(row);
            }
            // Completed + missing (deleted) → 404. Incomplete → finish below.
            if (existingIdem.completed) {
              return yield* Effect.fail(AppError.notFound("Item not found"));
            }
          }
        }

        const existing = yield* queryAllItems(tripId);
        // Best-effort under concurrent creates; serial path hard-rejects at 100.
        if (existing.length >= MAX_ITEMS_PER_TRIP) {
          return yield* Effect.fail(
            AppError.validation(
              `Item limit reached (max ${MAX_ITEMS_PER_TRIP} per trip)`,
              { maxItems: MAX_ITEMS_PER_TRIP },
            ),
          );
        }

        // Prefer reserved itemId from an existing claim (partial prior create).
        let itemId: string = crypto.randomUUID();
        if (idemKeyValue !== undefined) {
          const claim = yield* loadIdem(idemKeyValue);
          if (claim !== undefined) {
            if (claim.tripId !== tripId) {
              return yield* Effect.fail(
                AppError.conflict(
                  "Idempotency-Key already used for a different trip",
                  { tripId: claim.tripId },
                ),
              );
            }
            itemId = claim.itemId;
          } else {
            // Claim key first so concurrent creates share itemId.
            const ttl =
              Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS;
            const idemRow: IdempotencyItem = {
              PK: idemPk(ownerId),
              SK: idemSk(idemKeyValue),
              entityType: "IDEM",
              tripId,
              itemId,
              completed: false,
              ttl,
            };
            const claimWrite = yield* Effect.either(
              Effect.tryPromise({
                try: () =>
                  client.send(
                    new PutCommand({
                      TableName: tableName,
                      Item: idemRow,
                      ConditionExpression: "attribute_not_exists(PK)",
                    }),
                  ),
                catch: (cause) => cause,
              }),
            );
            if (Either.isLeft(claimWrite)) {
              const cause = claimWrite.left;
              if (cause instanceof ConditionalCheckFailedException) {
                const winner = yield* loadIdem(idemKeyValue);
                if (winner === undefined) {
                  return yield* Effect.fail(AppError.internal());
                }
                if (winner.tripId !== tripId) {
                  return yield* Effect.fail(
                    AppError.conflict(
                      "Idempotency-Key already used for a different trip",
                      { tripId: winner.tripId },
                    ),
                  );
                }
                const live = yield* getDynamoItem(tripId, winner.itemId);
                if (live !== undefined && live.ownerId === ownerId) {
                  return dynamoItemToDomain(live);
                }
                if (winner.completed) {
                  return yield* Effect.fail(AppError.notFound("Item not found"));
                }
                // Winner claimed but item not written yet — finish with reserved id.
                itemId = winner.itemId;
              } else {
                return yield* Effect.fail(mapDynamoError(cause));
              }
            }
          }
        }

        let item: ItineraryItem;
        try {
          const sortKey = nextAppendSortKey(existing.map((i) => i.sortKey));
          item = buildCreatedItem(tripId, input, sortKey, itemId);
        } catch (e) {
          return yield* Effect.fail(
            e instanceof AppError ? e : AppError.internal(),
          );
        }

        const row = domainItemToDynamo(ownerId, item);
        // Bump trip version + Put item so reorder If-Match covers item-set mutations.
        const tx = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new TransactWriteCommand({
                  TransactItems: [
                    {
                      Update: {
                        TableName: tableName,
                        Key: {
                          PK: userPk(ownerId),
                          SK: tripSk(tripId),
                        },
                        UpdateExpression: "SET #ver = #ver + :one",
                        ConditionExpression: "#status = :active",
                        ExpressionAttributeNames: {
                          "#ver": "version",
                          "#status": "status",
                        },
                        ExpressionAttributeValues: {
                          ":one": 1,
                          ":active": "active",
                        },
                      },
                    },
                    {
                      Put: {
                        TableName: tableName,
                        Item: row,
                        ConditionExpression: "attribute_not_exists(PK)",
                      },
                    },
                  ],
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(tx)) {
          const cause = tx.left;
          // Item already exists (retry after claim) — return live row.
          if (
            cause instanceof TransactionCanceledException ||
            (typeof cause === "object" &&
              cause !== null &&
              "name" in cause &&
              (cause as { name: string }).name === "TransactionCanceledException")
          ) {
            const live = yield* getDynamoItem(tripId, itemId);
            if (live !== undefined && live.ownerId === ownerId) {
              return dynamoItemToDomain(live);
            }
            return yield* Effect.fail(AppError.notFound("Trip not found"));
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        // Mark idempotency claim complete so delete-then-replay returns 404.
        if (idemKeyValue !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: {
                    PK: idemPk(ownerId),
                    SK: idemSk(idemKeyValue),
                  },
                  UpdateExpression: "SET completed = :c",
                  ExpressionAttributeValues: { ":c": true },
                }),
              ),
            catch: mapDynamoError,
          }).pipe(Effect.catchAll(() => Effect.void));
        }

        return item;
      }),

    updateItem: (ownerId, tripId, itemId, expectedVersion, patch) =>
      Effect.gen(function* () {
        yield* requireActiveTrip(ownerId, tripId);
        const row = yield* getDynamoItem(tripId, itemId);
        if (row === undefined || row.ownerId !== ownerId) {
          return yield* Effect.fail(AppError.notFound("Item not found"));
        }
        const existing = dynamoItemToDomain(row);
        if (existing.version !== expectedVersion) {
          return yield* Effect.fail(
            AppError.conflict("Version mismatch", {
              version: existing.version,
            }),
          );
        }

        let updateParts: ReturnType<typeof buildItemPatchUpdateExpression>;
        try {
          // Partial UpdateExpression — never writes sortKey (reorder-safe).
          updateParts = buildItemPatchUpdateExpression(
            existing,
            patch,
            expectedVersion,
          );
        } catch (e) {
          return yield* Effect.fail(
            e instanceof AppError ? e : AppError.internal(),
          );
        }

        const write = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: tripItemsPk(tripId), SK: itemSk(itemId) },
                  UpdateExpression: updateParts.updateExpression,
                  ConditionExpression: "#ver = :ev AND attribute_exists(PK)",
                  ExpressionAttributeNames: updateParts.expressionAttributeNames,
                  ExpressionAttributeValues:
                    updateParts.expressionAttributeValues,
                  ReturnValues: "ALL_NEW",
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(write)) {
          const cause = write.left;
          if (cause instanceof ConditionalCheckFailedException) {
            const live = yield* getDynamoItem(tripId, itemId);
            if (live === undefined || live.ownerId !== ownerId) {
              return yield* Effect.fail(AppError.notFound("Item not found"));
            }
            return yield* Effect.fail(
              AppError.conflict("Version mismatch", {
                version: live.version,
              }),
            );
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        const attrs = write.right.Attributes as DynamoItineraryItem | undefined;
        if (attrs !== undefined) {
          return dynamoItemToDomain(attrs);
        }
        // Fallback re-get (should be rare).
        const live = yield* getDynamoItem(tripId, itemId);
        if (live === undefined) {
          return yield* Effect.fail(AppError.notFound("Item not found"));
        }
        return dynamoItemToDomain(live);
      }),

    deleteItem: (ownerId, tripId, itemId) =>
      Effect.gen(function* () {
        yield* requireActiveTrip(ownerId, tripId);
        const row = yield* getDynamoItem(tripId, itemId);
        if (row === undefined || row.ownerId !== ownerId) {
          return yield* Effect.fail(AppError.notFound("Item not found"));
        }
        // Bump trip version + delete item so reorder If-Match covers item-set mutations.
        const tx = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new TransactWriteCommand({
                  TransactItems: [
                    {
                      Update: {
                        TableName: tableName,
                        Key: {
                          PK: userPk(ownerId),
                          SK: tripSk(tripId),
                        },
                        UpdateExpression: "SET #ver = #ver + :one",
                        ConditionExpression: "#status = :active",
                        ExpressionAttributeNames: {
                          "#ver": "version",
                          "#status": "status",
                        },
                        ExpressionAttributeValues: {
                          ":one": 1,
                          ":active": "active",
                        },
                      },
                    },
                    {
                      Delete: {
                        TableName: tableName,
                        Key: {
                          PK: tripItemsPk(tripId),
                          SK: itemSk(itemId),
                        },
                        ConditionExpression: "attribute_exists(PK)",
                      },
                    },
                  ],
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(tx)) {
          const cause = tx.left;
          if (
            cause instanceof TransactionCanceledException ||
            (typeof cause === "object" &&
              cause !== null &&
              "name" in cause &&
              (cause as { name: string }).name === "TransactionCanceledException")
          ) {
            return yield* Effect.fail(AppError.notFound("Item not found"));
          }
          if (cause instanceof ConditionalCheckFailedException) {
            return yield* Effect.fail(AppError.notFound("Item not found"));
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }
      }),

    reorderItems: (ownerId, tripId, expectedTripVersion, itemIds) =>
      Effect.gen(function* () {
        if (itemIds.length > MAX_ITEMS_PER_TRIP) {
          return yield* Effect.fail(
            AppError.validation(
              `itemIds length exceeds max items per trip (${MAX_ITEMS_PER_TRIP})`,
            ),
          );
        }
        const tripItem = yield* getTripItem(ownerId, tripId);
        if (tripItem === undefined || !isVisibleStatus(tripItem.status)) {
          return yield* Effect.fail(AppError.notFound("Trip not found"));
        }
        const trip = itemToTrip(tripItem);
        if (trip.version !== expectedTripVersion) {
          return yield* Effect.fail(
            AppError.conflict("Version mismatch", {
              version: trip.version,
            }),
          );
        }

        const current = yield* queryAllItems(tripId);
        const currentIds = new Set(current.map((i) => i.itemId));
        if (!isFullPermutation(itemIds, currentIds)) {
          return yield* Effect.fail(
            AppError.validation(
              "itemIds must be a full permutation of the trip's items",
            ),
          );
        }

        const newVersion = trip.version + 1;
        // Trip-level lock: bump version first (abort on CCF).
        const bump = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
                  UpdateExpression: "SET #ver = :nv",
                  ConditionExpression: "#ver = :ev AND #status = :active",
                  ExpressionAttributeNames: {
                    "#ver": "version",
                    "#status": "status",
                  },
                  ExpressionAttributeValues: {
                    ":nv": newVersion,
                    ":ev": expectedTripVersion,
                    ":active": "active",
                  },
                }),
              ),
            catch: (cause) => cause,
          }),
        );

        if (Either.isLeft(bump)) {
          const cause = bump.left;
          if (cause instanceof ConditionalCheckFailedException) {
            const live = yield* getTripItem(ownerId, tripId);
            if (live === undefined || !isVisibleStatus(live.status)) {
              return yield* Effect.fail(AppError.notFound("Trip not found"));
            }
            return yield* Effect.fail(
              AppError.conflict("Version mismatch", {
                version: live.version,
              }),
            );
          }
          return yield* Effect.fail(mapDynamoError(cause));
        }

        const assignments = computeReorderSortKeys(itemIds);
        const updatedAt = normalizeInstant(new Date().toISOString());
        const chunks = chunkArray(assignments, REORDER_CHUNK_SIZE);

        // Apply chunks sequentially; on failure retry remaining once.
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          if (chunk === undefined) {
            continue;
          }
          const first = yield* Effect.either(
            putItemSortKeysChunk(tripId, chunk, updatedAt),
          );
          if (Either.isLeft(first)) {
            const retry = yield* Effect.either(
              putItemSortKeysChunk(tripId, chunk, updatedAt),
            );
            if (Either.isLeft(retry)) {
              // Trip version already bumped — leave as-is (design partial failure).
              return yield* Effect.fail(mapDynamoError(retry.left));
            }
          }
        }

        const items = yield* queryAllItems(tripId);
        const result: ReorderItemsResult = {
          trip: { ...trip, version: newVersion },
          items,
        };
        return result;
      }),

    getByTripId: (tripId) =>
      Effect.tryPromise({
        try: async () => {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "GSI1",
              KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
              ExpressionAttributeValues: {
                ":pk": gsi1Pk(tripId),
                ":sk": "META",
              },
              Limit: 1,
            }),
          );
          const item = result.Items?.[0];
          if (item === undefined) {
            return undefined;
          }
          // GSI1 projects core trip attrs; prefer base Get for full consistency.
          const ownerId = item.ownerId;
          if (typeof ownerId === "string") {
            const base = await client.send(
              new GetCommand({
                TableName: tableName,
                Key: { PK: userPk(ownerId), SK: tripSk(tripId) },
              }),
            );
            if (base.Item !== undefined) {
              return itemToTrip(base.Item as TripItem);
            }
          }
          // Fall back to GSI1 projection shape.
          return itemToTrip({
            PK: typeof item.PK === "string" ? item.PK : userPk(String(ownerId)),
            SK: tripSk(tripId),
            GSI1PK: gsi1Pk(tripId),
            GSI1SK: "META",
            entityType: "TRIP",
            tripId,
            ownerId: String(ownerId),
            title: String(item.title ?? ""),
            timezone: String(item.timezone ?? "UTC"),
            startDate: String(item.startDate ?? "1970-01-01"),
            endDate: String(item.endDate ?? "1970-01-01"),
            version: typeof item.version === "number" ? item.version : 1,
            status:
              item.status === "deleting" || item.status === "deleted"
                ? item.status
                : "active",
            ...(typeof item.deletedAt === "string"
              ? { deletedAt: item.deletedAt }
              : {}),
          });
        },
        catch: mapDynamoError,
      }),

    listItemsByTripId: (tripId) => queryAllItems(tripId),
  };
}

/** Build document client for optional injection in tests. */
export function makeDynamoDocumentClient(
  client?: DynamoDBClient,
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}));
}
