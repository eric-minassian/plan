/**
 * Optional one-shot migration: enqueue cascade for trips already soft-deleted
 * (status=deleted) before PR 15, which may still have SHARE/ATT/ITEM children.
 *
 * Not wired as a scheduled job — invoke manually (ops/script) against a stage
 * table and the trip-delete queue URL.
 *
 * ## Dogfood ops (one-shot)
 *
 * ```ts
 * import { Effect } from "effect";
 * import { makeSqsTripDeleteQueue } from "../sqs/trip-delete-queue.js";
 * import {
 *   enqueueCascadeForCandidates,
 *   listDeletedTripCandidates,
 * } from "./migrate-deleted-trips.js";
 *
 * const tableName = process.env.TABLE_NAME!;
 * const queueUrl = process.env.TRIP_DELETE_QUEUE_URL!;
 * const queue = makeSqsTripDeleteQueue({ queueUrl });
 * const n = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const candidates = yield* listDeletedTripCandidates(tableName);
 *     return yield* enqueueCascadeForCandidates(queue, candidates);
 *   }),
 * );
 * console.log("enqueued", n);
 * ```
 *
 * Env: `TABLE_NAME`, `TRIP_DELETE_QUEUE_URL`, AWS credentials for the stage.
 * Scan + FilterExpression is expensive — dogfood only, not a hot path.
 *
 * Strategy:
 *  1. Scan trip meta with status deleted/deleting (or pass known pairs).
 *  2. Enqueue each onto the trip-delete queue; the worker is idempotent and
 *     backfills meta `ttl` when missing.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import { internalFromCause } from "../errors/app-error.js";
import type {
  TripDeleteMessage,
  TripDeleteQueueService,
} from "../sqs/trip-delete-queue.js";

export interface DeletedTripCandidate {
  readonly tripId: string;
  readonly ownerId: string;
  readonly status: "deleted" | "deleting";
}

/**
 * Scan trip meta rows with status deleted/deleting (FilterExpression).
 * Expensive — dogfood/ops only; not for hot paths.
 */
export function listDeletedTripCandidates(
  tableName: string,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({}),
  ),
): Effect.Effect<readonly DeletedTripCandidate[], AppError> {
  return Effect.tryPromise({
    try: async () => {
      const found: DeletedTripCandidate[] = [];
      let exclusiveStartKey:
        | Record<string, NativeAttributeValue>
        | undefined;
      do {
        const result = await client.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression:
              "entityType = :trip AND (#status = :deleted OR #status = :deleting)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":trip": "TRIP",
              ":deleted": "deleted",
              ":deleting": "deleting",
            },
            ProjectionExpression: "tripId, ownerId, #status",
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of result.Items ?? []) {
          const tripId = item.tripId;
          const ownerId = item.ownerId;
          const status = item.status;
          if (
            typeof tripId === "string" &&
            typeof ownerId === "string" &&
            (status === "deleted" || status === "deleting")
          ) {
            found.push({ tripId, ownerId, status });
          }
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return found;
    },
    catch: (cause) =>
      internalFromCause(cause, { component: "migrate-deleted-trips" }),
  });
}

/** Enqueue cascade for each candidate (worker handles children + S3 + ttl). */
export function enqueueCascadeForCandidates(
  queue: TripDeleteQueueService,
  candidates: readonly DeletedTripCandidate[],
): Effect.Effect<number, AppError> {
  return Effect.gen(function* () {
    let n = 0;
    for (const c of candidates) {
      const message: TripDeleteMessage = {
        tripId: c.tripId,
        ownerId: c.ownerId,
      };
      yield* queue.enqueue(message);
      n += 1;
    }
    return n;
  });
}
