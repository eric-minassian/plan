import type { Attachment, AttachmentStatus } from "@tripplan/domain";
import {
  PENDING_ATTACHMENT_TTL_SECONDS,
  normalizeInstant,
} from "@tripplan/domain";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import { AppError, internalFromCause } from "../errors/app-error.js";
import { tripItemsPk } from "./dynamo-trip-repo.js";
import type {
  AttachmentRepository,
  CreatePendingAttachmentInput,
} from "./attachment-repo.js";

/** Dynamo attachment row: PK=TRIP#tripId, SK=ATT#itemId#attachmentId. */
export interface DynamoAttachment {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: "ATT";
  readonly attachmentId: string;
  readonly tripId: string;
  readonly itemId: string;
  readonly s3Key: string;
  readonly status: AttachmentStatus;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  /** Dynamo TTL (epoch seconds) — only set while pending. */
  readonly ttl?: number;
}

export function attSk(itemId: string, attachmentId: string): string {
  return `ATT#${itemId}#${attachmentId}`;
}

export function attSkPrefixForItem(itemId: string): string {
  return `ATT#${itemId}#`;
}

export function attSkPrefixAll(): string {
  return "ATT#";
}

function mapDynamoError(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, { component: "dynamo-attachment-repo" });
}

function nowInstant(now: Date = new Date()): string {
  return normalizeInstant(now.toISOString());
}

function addSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

export function dynamoAttToDomain(row: DynamoAttachment): Attachment {
  return {
    attachmentId: row.attachmentId,
    tripId: row.tripId,
    itemId: row.itemId,
    s3Key: row.s3Key,
    status: row.status,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    createdAt: row.createdAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
  };
}

function isAttachmentRow(
  item: Record<string, NativeAttributeValue>,
): item is DynamoAttachment & Record<string, NativeAttributeValue> {
  return (
    item.entityType === "ATT" &&
    typeof item.attachmentId === "string" &&
    typeof item.tripId === "string" &&
    typeof item.itemId === "string" &&
    typeof item.s3Key === "string" &&
    (item.status === "pending" || item.status === "ready") &&
    typeof item.contentType === "string" &&
    typeof item.sizeBytes === "number" &&
    typeof item.fileName === "string" &&
    typeof item.createdAt === "string"
  );
}

function sortByCreatedAt(a: Attachment, b: Attachment): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.attachmentId < b.attachmentId) return -1;
  if (a.attachmentId > b.attachmentId) return 1;
  return 0;
}

export function makeDynamoAttachmentRepo(
  tableName: string,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({}),
  ),
): AttachmentRepository {
  const queryAll = (
    tripId: string,
    skPrefix: string,
  ): Effect.Effect<readonly Attachment[], AppError> =>
    Effect.tryPromise({
      try: async () => {
        const out: Attachment[] = [];
        let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression:
                "PK = :pk AND begins_with(SK, :skPrefix)",
              ExpressionAttributeValues: {
                ":pk": tripItemsPk(tripId),
                ":skPrefix": skPrefix,
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          for (const item of result.Items ?? []) {
            if (isAttachmentRow(item)) {
              out.push(dynamoAttToDomain(item));
            }
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
        return out.sort(sortByCreatedAt);
      },
      catch: mapDynamoError,
    });

  return {
    createPending: (input: CreatePendingAttachmentInput) =>
      Effect.tryPromise({
        try: async () => {
          const now = input.now ?? new Date();
          const createdAt = nowInstant(now);
          const expiresDate = addSeconds(now, PENDING_ATTACHMENT_TTL_SECONDS);
          const expiresAt = nowInstant(expiresDate);
          const ttl = Math.floor(expiresDate.getTime() / 1000);
          const row: DynamoAttachment = {
            PK: tripItemsPk(input.tripId),
            SK: attSk(input.itemId, input.attachmentId),
            entityType: "ATT",
            attachmentId: input.attachmentId,
            tripId: input.tripId,
            itemId: input.itemId,
            s3Key: input.s3Key,
            status: "pending",
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            fileName: input.fileName,
            createdAt,
            expiresAt,
            ttl,
          };
          await client.send(
            new PutCommand({
              TableName: tableName,
              Item: row,
              ConditionExpression:
                "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            }),
          );
          return dynamoAttToDomain(row);
        },
        catch: (cause) => {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "name" in cause &&
            (cause as { name: string }).name ===
              "ConditionalCheckFailedException"
          ) {
            return AppError.conflict("Attachment already exists");
          }
          return mapDynamoError(cause);
        },
      }),

    get: (tripId, itemId, attachmentId) =>
      Effect.tryPromise({
        try: async () => {
          const result = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: tripItemsPk(tripId),
                SK: attSk(itemId, attachmentId),
              },
            }),
          );
          const item = result.Item;
          if (item === undefined || !isAttachmentRow(item)) {
            return undefined;
          }
          return dynamoAttToDomain(item);
        },
        catch: mapDynamoError,
      }),

    listForItem: (tripId, itemId) =>
      queryAll(tripId, attSkPrefixForItem(itemId)),

    listReadyForTrip: (tripId) =>
      Effect.gen(function* () {
        const all = yield* queryAll(tripId, attSkPrefixAll());
        return all.filter((a) => a.status === "ready");
      }),

    confirmReady: (tripId, itemId, attachmentId) =>
      Effect.gen(function* () {
        const updated = yield* Effect.tryPromise({
          try: async () => {
            try {
              const result = await client.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: {
                    PK: tripItemsPk(tripId),
                    SK: attSk(itemId, attachmentId),
                  },
                  UpdateExpression:
                    "SET #status = :ready REMOVE expiresAt, #ttl",
                  ConditionExpression:
                    "attribute_exists(PK) AND #status = :pending",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#ttl": "ttl",
                  },
                  ExpressionAttributeValues: {
                    ":ready": "ready",
                    ":pending": "pending",
                  },
                  ReturnValues: "ALL_NEW",
                }),
              );
              return { ok: true as const, item: result.Attributes };
            } catch (cause: unknown) {
              if (
                typeof cause === "object" &&
                cause !== null &&
                "name" in cause &&
                (cause as { name: string }).name ===
                  "ConditionalCheckFailedException"
              ) {
                return { ok: false as const };
              }
              throw cause;
            }
          },
          catch: mapDynamoError,
        });

        if (updated.ok) {
          const item = updated.item;
          if (item === undefined || !isAttachmentRow(item)) {
            return yield* Effect.fail(AppError.internal());
          }
          return dynamoAttToDomain(item);
        }

        const existing = yield* Effect.tryPromise({
          try: async () => {
            const got = await client.send(
              new GetCommand({
                TableName: tableName,
                Key: {
                  PK: tripItemsPk(tripId),
                  SK: attSk(itemId, attachmentId),
                },
              }),
            );
            return got.Item;
          },
          catch: mapDynamoError,
        });
        if (existing === undefined || !isAttachmentRow(existing)) {
          return yield* Effect.fail(AppError.notFound("Attachment not found"));
        }
        return yield* Effect.fail(
          AppError.conflict("Attachment is not pending", {
            status: existing.status,
          }),
        );
      }),

    delete: (tripId, itemId, attachmentId) =>
      Effect.tryPromise({
        try: async () => {
          await client.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: tripItemsPk(tripId),
                SK: attSk(itemId, attachmentId),
              },
              ConditionExpression: "attribute_exists(PK)",
            }),
          );
        },
        catch: (cause) => {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "name" in cause &&
            (cause as { name: string }).name ===
              "ConditionalCheckFailedException"
          ) {
            return AppError.notFound("Attachment not found");
          }
          return mapDynamoError(cause);
        },
      }),

    deleteAllForItem: (tripId, itemId) =>
      Effect.gen(function* () {
        const existing = yield* queryAll(tripId, attSkPrefixForItem(itemId));
        for (const att of existing) {
          yield* Effect.tryPromise({
            try: async () => {
              await client.send(
                new DeleteCommand({
                  TableName: tableName,
                  Key: {
                    PK: tripItemsPk(att.tripId),
                    SK: attSk(att.itemId, att.attachmentId),
                  },
                }),
              );
            },
            catch: mapDynamoError,
          });
        }
        return existing;
      }),
  };
}
