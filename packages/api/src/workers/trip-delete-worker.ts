/**
 * Trip-delete cascade worker (SQS → Lambda).
 *
 * For each message { tripId, ownerId }:
 *  0. Load trip meta — no-op if missing; skip unless status ∈ {deleting,deleted}
 *     and ownerId matches (refuse purge of active/wrong-owner trips)
 *  1. Query GSI3 only → delete all share sessions for the trip (BatchWrite ≤25)
 *  2. Query PK=TRIP#tripId → delete SHARE# / ATT# / ITEM# (BatchWrite ≤25)
 *  3. S3 keys from ATT meta (prefix-scoped) + prefix safety trips/{tripId}/
 *  4. Set trip meta status=deleted (ttl backfilled if missing)
 *
 * Idempotent: re-running after a full purge is a no-op success.
 * Also handles pre-PR15 interim soft-deletes (status already `deleted`
 * with leftover children) — cascade children, leave meta deleted + ttl.
 */
import type { SQSEvent, SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type DeleteObjectsCommandOutput,
} from "@aws-sdk/client-s3";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import { loadConfig } from "../config.js";
import { AppError, internalFromCause } from "../errors/app-error.js";
import { consoleLogger, type Logger } from "../logging/logger.js";
import { makeDynamoTripRepo, tripItemsPk } from "../repos/dynamo-trip-repo.js";
import type { TripRepository } from "../repos/trip-repo.js";
import { gsi3PkForTrip } from "../repos/share-token.js";
import {
  parseTripDeleteMessage,
  type TripDeleteMessage,
} from "../sqs/trip-delete-queue.js";

const BATCH_WRITE_MAX = 25;
const S3_DELETE_MAX = 1000;

/** S3 keys collected from ATT rows during partition purge. */
export interface CascadeResult {
  readonly sessionsDeleted: number;
  readonly childrenDeleted: number;
  readonly s3KeysFromMeta: readonly string[];
  readonly s3KeysFromPrefix: number;
  /** Set when cascade intentionally skipped purge (message acked). */
  readonly skipped?: "missing" | "not_deleting" | "owner_mismatch";
}

export interface TripDeleteCascadeDeps {
  readonly tableName: string;
  readonly docsBucketName: string;
  readonly ddb?: DynamoDBDocumentClient;
  readonly s3?: S3Client;
  readonly tripRepo?: TripRepository;
  readonly logger?: Logger;
}

function mapDynamoError(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, { component: "trip-delete-worker" });
}

function mapS3Error(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, { component: "trip-delete-worker-s3" });
}

/** Only delete objects under the trip's prefix (defense in depth). */
export function isTripScopedS3Key(tripId: string, key: string): boolean {
  return key.startsWith(`trips/${tripId}/`);
}

export function filterTripScopedS3Keys(
  tripId: string,
  keys: readonly string[],
): { readonly allowed: readonly string[]; readonly rejected: readonly string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const key of keys) {
    if (isTripScopedS3Key(tripId, key)) {
      allowed.push(key);
    } else {
      rejected.push(key);
    }
  }
  return { allowed, rejected };
}

interface DynamoKey {
  readonly PK: string;
  readonly SK: string;
}

/**
 * BatchWrite DeleteRequest chunks of ≤25 with UnprocessedItems retry.
 */
export function batchDeleteKeys(
  tableName: string,
  keys: readonly DynamoKey[],
  client: DynamoDBDocumentClient,
): Effect.Effect<number, AppError> {
  if (keys.length === 0) {
    return Effect.succeed(0);
  }
  return Effect.tryPromise({
    try: async () => {
      let deleted = 0;
      for (let i = 0; i < keys.length; i += BATCH_WRITE_MAX) {
        let pending = keys.slice(i, i + BATCH_WRITE_MAX).map((Key) => ({
          DeleteRequest: { Key: { PK: Key.PK, SK: Key.SK } },
        }));
        let attempts = 0;
        while (pending.length > 0 && attempts < 8) {
          attempts += 1;
          const result = await client.send(
            new BatchWriteCommand({
              RequestItems: { [tableName]: pending },
            }),
          );
          const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
          const processed = pending.length - unprocessed.length;
          deleted += Math.max(0, processed);
          pending = unprocessed as typeof pending;
          if (pending.length === 0) {
            break;
          }
          // Brief backoff before retrying unprocessed.
          await new Promise((r) => setTimeout(r, 25 * attempts));
        }
        if (pending.length > 0) {
          throw new Error(
            `BatchWrite left ${String(pending.length)} unprocessed deletes`,
          );
        }
      }
      return deleted;
    },
    catch: mapDynamoError,
  });
}

/**
 * Query GSI3 (sessions by trip) and BatchWrite-delete each base key.
 * Design: trip-wide purge uses GSI3 only (not GSI4). KEYS_ONLY projects PK/SK.
 */
export function purgeSessionsForTrip(
  tableName: string,
  tripId: string,
  client: DynamoDBDocumentClient,
): Effect.Effect<number, AppError> {
  return Effect.gen(function* () {
    const keys: DynamoKey[] = [];
    yield* Effect.tryPromise({
      try: async () => {
        let exclusiveStartKey:
          | Record<string, NativeAttributeValue>
          | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "GSI3",
              KeyConditionExpression: "GSI3PK = :pk",
              ExpressionAttributeValues: {
                ":pk": gsi3PkForTrip(tripId),
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          for (const item of result.Items ?? []) {
            const pk = item.PK;
            const sk = item.SK;
            if (typeof pk === "string" && typeof sk === "string") {
              keys.push({ PK: pk, SK: sk });
            }
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
      },
      catch: mapDynamoError,
    });
    return yield* batchDeleteKeys(tableName, keys, client);
  });
}

/**
 * Delete all child rows under PK=TRIP#tripId (SHARE / ATT / ITEM).
 * Returns count deleted and trip-scoped s3Keys from ATT rows.
 */
export function purgeTripPartitionChildren(
  tableName: string,
  tripId: string,
  client: DynamoDBDocumentClient,
  logger: Logger = consoleLogger,
): Effect.Effect<
  { readonly deleted: number; readonly s3Keys: readonly string[] },
  AppError
> {
  return Effect.gen(function* () {
    const keys: DynamoKey[] = [];
    const rawS3Keys: string[] = [];
    yield* Effect.tryPromise({
      try: async () => {
        let exclusiveStartKey:
          | Record<string, NativeAttributeValue>
          | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :pk",
              ExpressionAttributeValues: {
                ":pk": tripItemsPk(tripId),
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          for (const item of result.Items ?? []) {
            const pk = item.PK;
            const sk = item.SK;
            if (typeof pk !== "string" || typeof sk !== "string") {
              continue;
            }
            if (
              sk.startsWith("ATT#") &&
              typeof item.s3Key === "string" &&
              item.s3Key.length > 0
            ) {
              rawS3Keys.push(item.s3Key);
            }
            keys.push({ PK: pk, SK: sk });
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
      },
      catch: mapDynamoError,
    });

    const { allowed, rejected } = filterTripScopedS3Keys(tripId, rawS3Keys);
    if (rejected.length > 0) {
      logger.log("warn", "trip-delete skipped non-scoped s3Key", {
        tripId,
        rejectedCount: rejected.length,
      });
    }

    const deleted = yield* batchDeleteKeys(tableName, keys, client);
    return { deleted, s3Keys: allowed };
  });
}

function assertNoS3DeleteErrors(
  result: DeleteObjectsCommandOutput,
  context: string,
): void {
  const errors = result.Errors ?? [];
  if (errors.length === 0) {
    return;
  }
  const sample = errors
    .slice(0, 5)
    .map((e) => `${e.Key ?? "?"}:${e.Code ?? "Error"}`)
    .join(",");
  throw new Error(
    `S3 DeleteObjects partial failure (${context}): ${String(errors.length)} errors e.g. ${sample}`,
  );
}

/** Delete specific S3 object keys in batches of ≤1000. Fails on any Errors. */
export function deleteS3Keys(
  bucketName: string,
  keys: readonly string[],
  s3: S3Client,
): Effect.Effect<number, AppError> {
  if (keys.length === 0) {
    return Effect.succeed(0);
  }
  return Effect.tryPromise({
    try: async () => {
      let removed = 0;
      const unique = [...new Set(keys)];
      for (let i = 0; i < unique.length; i += S3_DELETE_MAX) {
        const chunk = unique.slice(i, i + S3_DELETE_MAX);
        const result = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: chunk.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        assertNoS3DeleteErrors(result, "keys");
        removed += chunk.length;
      }
      return removed;
    },
    catch: mapS3Error,
  });
}

/**
 * List + delete all objects under trips/{tripId}/ (safety net for orphans).
 * Fails on DeleteObjects Errors so SQS retries / DLQ.
 */
export function deleteS3Prefix(
  bucketName: string,
  tripId: string,
  s3: S3Client,
): Effect.Effect<number, AppError> {
  const prefix = `trips/${tripId}/`;
  return Effect.tryPromise({
    try: async () => {
      let removed = 0;
      let continuationToken: string | undefined;
      do {
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const keys = (listed.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => typeof k === "string" && k.length > 0);
        if (keys.length > 0) {
          for (let i = 0; i < keys.length; i += S3_DELETE_MAX) {
            const chunk = keys.slice(i, i + S3_DELETE_MAX);
            const result = await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: {
                  Objects: chunk.map((Key) => ({ Key })),
                  Quiet: true,
                },
              }),
            );
            assertNoS3DeleteErrors(result, `prefix ${prefix}`);
            removed += chunk.length;
          }
        }
        continuationToken = listed.IsTruncated
          ? listed.NextContinuationToken
          : undefined;
      } while (continuationToken !== undefined);
      return removed;
    },
    catch: mapS3Error,
  });
}

/**
 * Full cascade for one trip. Injectable deps for unit tests.
 * Verifies status ∈ {deleting, deleted} and ownerId match before any purge.
 */
export function runTripDeleteCascade(
  message: TripDeleteMessage,
  deps: TripDeleteCascadeDeps,
): Effect.Effect<CascadeResult, AppError> {
  const logger = deps.logger ?? consoleLogger;
  const ddb =
    deps.ddb ??
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const s3 =
    deps.s3 ??
    new S3Client({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  const tripRepo: TripRepository =
    deps.tripRepo ?? makeDynamoTripRepo(deps.tableName, ddb);

  return Effect.gen(function* () {
    logger.log("info", "trip-delete cascade start", {
      tripId: message.tripId,
      ownerId: message.ownerId,
    });

    // Guard: never purge active trips or wrong-owner messages.
    const trip = yield* tripRepo.getByTripId(message.tripId);
    if (trip === undefined) {
      logger.log("info", "trip-delete skip missing meta", {
        tripId: message.tripId,
      });
      return {
        sessionsDeleted: 0,
        childrenDeleted: 0,
        s3KeysFromMeta: [],
        s3KeysFromPrefix: 0,
        skipped: "missing" as const,
      };
    }
    if (trip.ownerId !== message.ownerId) {
      logger.log("error", "trip-delete owner mismatch — refusing purge", {
        tripId: message.tripId,
        messageOwnerId: message.ownerId,
        // Log length only — avoid treating ownerId as free-form PII dump.
        metaOwnerLen: trip.ownerId.length,
      });
      return {
        sessionsDeleted: 0,
        childrenDeleted: 0,
        s3KeysFromMeta: [],
        s3KeysFromPrefix: 0,
        skipped: "owner_mismatch" as const,
      };
    }
    if (trip.status !== "deleting" && trip.status !== "deleted") {
      logger.log("error", "trip-delete refuse active/non-deleting trip", {
        tripId: message.tripId,
        status: trip.status,
      });
      return {
        sessionsDeleted: 0,
        childrenDeleted: 0,
        s3KeysFromMeta: [],
        s3KeysFromPrefix: 0,
        skipped: "not_deleting" as const,
      };
    }

    const sessionsDeleted = yield* purgeSessionsForTrip(
      deps.tableName,
      message.tripId,
      ddb,
    );

    const children = yield* purgeTripPartitionChildren(
      deps.tableName,
      message.tripId,
      ddb,
      logger,
    );

    // Prefer keys from ATT meta; prefix sweep catches orphans.
    yield* deleteS3Keys(deps.docsBucketName, children.s3Keys, s3);
    const s3KeysFromPrefix = yield* deleteS3Prefix(
      deps.docsBucketName,
      message.tripId,
      s3,
    );

    // Finalize meta (idempotent if already deleted; backfills ttl when missing).
    yield* tripRepo.markDeleted(message.ownerId, message.tripId).pipe(
      Effect.catchAll((err) => {
        // Missing meta after purge is acceptable (rare race / already TTL'd).
        if (err.type === "NotFound") {
          return Effect.void;
        }
        return Effect.fail(err);
      }),
    );

    const result: CascadeResult = {
      sessionsDeleted,
      childrenDeleted: children.deleted,
      s3KeysFromMeta: children.s3Keys,
      s3KeysFromPrefix,
    };
    logger.log("info", "trip-delete cascade complete", {
      tripId: message.tripId,
      sessionsDeleted: result.sessionsDeleted,
      childrenDeleted: result.childrenDeleted,
      s3KeysFromMeta: children.s3Keys.length,
      s3KeysFromPrefix: result.s3KeysFromPrefix,
    });
    return result;
  });
}

export interface CreateWorkerHandlerOptions {
  readonly tableName?: string;
  readonly docsBucketName?: string;
  readonly ddb?: DynamoDBDocumentClient;
  readonly s3?: S3Client;
  readonly tripRepo?: TripRepository;
  readonly logger?: Logger;
  /** Override cascade for pure unit tests. */
  readonly cascade?: (
    message: TripDeleteMessage,
  ) => Effect.Effect<CascadeResult, AppError>;
}

/**
 * Build an SQS Lambda handler. Throws on per-record failure so partial batch
 * item failures surface (default all-or-nothing; SQS retries / DLQ).
 */
export function createTripDeleteWorkerHandler(
  options: CreateWorkerHandlerOptions = {},
): SQSHandler {
  const config = loadConfig();
  const tableName = options.tableName ?? config.tableName;
  const docsBucketName = options.docsBucketName ?? config.docsBucketName;
  const logger = options.logger ?? consoleLogger;

  return async (event: SQSEvent): Promise<void> => {
    if (tableName === undefined || tableName.length === 0) {
      throw new Error("TABLE_NAME is required for trip-delete worker");
    }
    if (docsBucketName === undefined || docsBucketName.length === 0) {
      throw new Error("DOCS_BUCKET_NAME is required for trip-delete worker");
    }

    for (const record of event.Records) {
      const message = parseTripDeleteMessage(record.body);
      if (message === undefined) {
        logger.log("error", "trip-delete invalid message body", {
          messageId: record.messageId,
        });
        throw new Error(
          `Invalid trip-delete message body (messageId=${record.messageId})`,
        );
      }

      const program =
        options.cascade !== undefined
          ? options.cascade(message)
          : runTripDeleteCascade(message, {
              tableName,
              docsBucketName,
              ...(options.ddb !== undefined ? { ddb: options.ddb } : {}),
              ...(options.s3 !== undefined ? { s3: options.s3 } : {}),
              ...(options.tripRepo !== undefined
                ? { tripRepo: options.tripRepo }
                : {}),
              logger,
            });

      await Effect.runPromise(program);
    }
  };
}

/** Default Lambda entry used by ApiStack bundling. */
export const handler: SQSHandler = createTripDeleteWorkerHandler();
