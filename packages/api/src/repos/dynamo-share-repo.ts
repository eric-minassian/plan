import type { ShareGrant, ShareSession } from "@tripplan/domain";
import {
  MAX_ACTIVE_SHARES_PER_TRIP,
  SHARE_SESSION_TTL_SECONDS,
  normalizeInstant,
} from "@tripplan/domain";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
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
import {
  generateSessionId,
  generateShareId,
  generateShareToken,
  gsi3PkForTrip,
  gsi3SkForSession,
  gsi4PkForShare,
  gsi4SkForSession,
  hashShareToken,
  sessionPk,
  sessionSk,
  shareSk,
  shareTokenGsi2Pk,
} from "./share-token.js";
import {
  resolveGrantExpiresAt,
  type CreateShareGrantResult,
  type ShareRepository,
} from "./share-repo.js";
import { tripItemsPk } from "./dynamo-trip-repo.js";

/** Dynamo share grant row (PK=TRIP#tripId, SK=SHARE#shareId, GSI2). */
export interface DynamoShareGrant {
  readonly PK: string;
  readonly SK: string;
  readonly GSI2PK: string;
  readonly GSI2SK: string;
  readonly entityType: "SHARE";
  readonly shareId: string;
  readonly tripId: string;
  readonly ownerId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly label: string;
}

/** Dynamo share session row (PK=SESSION#id, SK=META, GSI3/GSI4, TTL). */
export interface DynamoShareSession {
  readonly PK: string;
  readonly SK: string;
  readonly GSI3PK: string;
  readonly GSI3SK: string;
  readonly GSI4PK: string;
  readonly GSI4SK: string;
  readonly entityType: "SESSION";
  readonly sessionId: string;
  readonly tripId: string;
  readonly shareId: string;
  readonly exp: string;
  /** Dynamo TTL (epoch seconds). */
  readonly ttl: number;
}

function mapDynamoError(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, { component: "dynamo-share-repo" });
}

export function dynamoGrantToDomain(row: DynamoShareGrant): ShareGrant {
  return {
    shareId: row.shareId,
    tripId: row.tripId,
    ownerId: row.ownerId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    revoked: row.revoked,
    label: row.label,
  };
}

/** GSI2 projection may omit some attrs; prefer base Get when available. */
function gsi2ToGrant(item: Record<string, NativeAttributeValue>): ShareGrant | undefined {
  const shareId = item.shareId;
  const tripId = item.tripId;
  const ownerId = item.ownerId;
  const expiresAt = item.expiresAt;
  const revoked = item.revoked;
  if (
    typeof shareId !== "string" ||
    typeof tripId !== "string" ||
    typeof ownerId !== "string" ||
    typeof expiresAt !== "string" ||
    typeof revoked !== "boolean"
  ) {
    return undefined;
  }
  // tokenHash is not projected on GSI2 INCLUDE list — reconstruct from GSI2PK when present.
  let tokenHash = typeof item.tokenHash === "string" ? item.tokenHash : "";
  if (tokenHash.length === 0 && typeof item.GSI2PK === "string") {
    const prefix = "SHARETOKEN#";
    if (item.GSI2PK.startsWith(prefix)) {
      tokenHash = item.GSI2PK.slice(prefix.length);
    }
  }
  return {
    shareId,
    tripId,
    ownerId,
    tokenHash,
    expiresAt,
    revoked,
    label: typeof item.label === "string" ? item.label : "",
  };
}

export function dynamoSessionToDomain(row: DynamoShareSession): ShareSession {
  return {
    sessionId: row.sessionId,
    tripId: row.tripId,
    shareId: row.shareId,
    exp: row.exp,
  };
}

/**
 * DynamoDB share grant + session repository (GSI2 token, GSI3/GSI4 sessions).
 */
export function makeDynamoShareRepo(
  tableName: string,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({}),
  ),
): ShareRepository {
  const getGrantItem = (
    tripId: string,
    shareId: string,
  ): Effect.Effect<DynamoShareGrant | undefined, AppError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              PK: tripItemsPk(tripId),
              SK: shareSk(shareId),
            },
          }),
        );
        if (result.Item === undefined) {
          return undefined;
        }
        return result.Item as DynamoShareGrant;
      },
      catch: mapDynamoError,
    });

  const deleteSessionsForShare = (
    shareId: string,
  ): Effect.Effect<void, AppError> =>
    Effect.tryPromise({
      try: async () => {
        // GSI4 only (design): revoke path never uses GSI3.
        let exclusiveStartKey:
          | Record<string, NativeAttributeValue>
          | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: "GSI4",
              KeyConditionExpression: "GSI4PK = :pk",
              ExpressionAttributeValues: {
                ":pk": gsi4PkForShare(shareId),
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );
          for (const item of result.Items ?? []) {
            const pk = item.PK;
            const sk = item.SK;
            if (typeof pk === "string" && typeof sk === "string") {
              await client.send(
                new DeleteCommand({
                  TableName: tableName,
                  Key: { PK: pk, SK: sk },
                }),
              );
            }
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
      },
      catch: mapDynamoError,
    });

  return {
    createGrant: (ownerId, tripId, input, now = new Date()) =>
      Effect.gen(function* () {
        const expiresAt = yield* resolveGrantExpiresAt(input.expiresAt, now);
        // Best-effort active-grant quota (check-then-act; same pattern as trip/item caps).
        const listed = yield* Effect.tryPromise({
          try: async () => {
            let active = 0;
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
                    ":sk": "SHARE#",
                  },
                  ExclusiveStartKey: exclusiveStartKey,
                }),
              );
              for (const raw of result.Items ?? []) {
                if (raw.revoked !== true) {
                  active += 1;
                }
              }
              exclusiveStartKey = result.LastEvaluatedKey;
            } while (exclusiveStartKey !== undefined);
            return active;
          },
          catch: mapDynamoError,
        });
        if (listed >= MAX_ACTIVE_SHARES_PER_TRIP) {
          return yield* Effect.fail(
            AppError.validation(
              `Active share limit reached (max ${String(MAX_ACTIVE_SHARES_PER_TRIP)} per trip)`,
              { maxActiveShares: MAX_ACTIVE_SHARES_PER_TRIP },
            ),
          );
        }
        const rawToken = generateShareToken();
        const tokenHash = hashShareToken(rawToken);
        const shareId = generateShareId();
        const grant: ShareGrant = {
          shareId,
          tripId,
          ownerId,
          tokenHash,
          expiresAt,
          revoked: false,
          label: input.label ?? "",
        };
        const item: DynamoShareGrant = {
          PK: tripItemsPk(tripId),
          SK: shareSk(shareId),
          GSI2PK: shareTokenGsi2Pk(tokenHash),
          GSI2SK: `TRIP#${tripId}`,
          entityType: "SHARE",
          shareId,
          tripId,
          ownerId,
          tokenHash,
          expiresAt,
          revoked: false,
          label: grant.label,
        };
        yield* Effect.tryPromise({
          try: async () => {
            await client.send(
              new PutCommand({
                TableName: tableName,
                Item: item,
                ConditionExpression:
                  "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              }),
            );
          },
          catch: mapDynamoError,
        });
        const result: CreateShareGrantResult = { grant, rawToken };
        return result;
      }),

    listGrants: (tripId) =>
      Effect.tryPromise({
        try: async () => {
          const collected: ShareGrant[] = [];
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
                  ":sk": "SHARE#",
                },
                ExclusiveStartKey: exclusiveStartKey,
              }),
            );
            for (const raw of result.Items ?? []) {
              collected.push(dynamoGrantToDomain(raw as DynamoShareGrant));
            }
            exclusiveStartKey = result.LastEvaluatedKey;
          } while (exclusiveStartKey !== undefined);
          collected.sort((a, b) =>
            a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0,
          );
          return collected;
        },
        catch: mapDynamoError,
      }),

    getGrant: (tripId, shareId) =>
      Effect.gen(function* () {
        const item = yield* getGrantItem(tripId, shareId);
        return item === undefined ? undefined : dynamoGrantToDomain(item);
      }),

    findGrantByTokenHash: (tokenHash) =>
      Effect.tryPromise({
        try: async () => {
          const queryOnce = async () => {
            const result = await client.send(
              new QueryCommand({
                TableName: tableName,
                IndexName: "GSI2",
                KeyConditionExpression: "GSI2PK = :pk",
                ExpressionAttributeValues: {
                  ":pk": shareTokenGsi2Pk(tokenHash),
                },
                Limit: 1,
              }),
            );
            const item = result.Items?.[0];
            if (item === undefined) {
              return undefined;
            }
            // Prefer base Get for full grant (GSI2 is INCLUDE projection).
            const tripId = item.tripId;
            const shareId = item.shareId;
            if (typeof tripId === "string" && typeof shareId === "string") {
              const base = await client.send(
                new GetCommand({
                  TableName: tableName,
                  Key: {
                    PK: tripItemsPk(tripId),
                    SK: shareSk(shareId),
                  },
                }),
              );
              if (base.Item !== undefined) {
                return dynamoGrantToDomain(base.Item as DynamoShareGrant);
              }
            }
            return gsi2ToGrant(item);
          };
          // Eventually consistent GSI — retry once on miss (design).
          const first = await queryOnce();
          if (first !== undefined) {
            return first;
          }
          await new Promise((r) => setTimeout(r, 50));
          return queryOnce();
        },
        catch: mapDynamoError,
      }),

    revokeGrant: (ownerId, tripId, shareId) =>
      Effect.gen(function* () {
        const existing = yield* getGrantItem(tripId, shareId);
        if (existing === undefined || existing.ownerId !== ownerId) {
          return yield* Effect.fail(AppError.notFound("Share not found"));
        }
        yield* Effect.tryPromise({
          try: async () => {
            await client.send(
              new UpdateCommand({
                TableName: tableName,
                Key: {
                  PK: tripItemsPk(tripId),
                  SK: shareSk(shareId),
                },
                UpdateExpression: "SET revoked = :true",
                ExpressionAttributeValues: { ":true": true },
                ConditionExpression: "attribute_exists(PK)",
              }),
            );
          },
          catch: mapDynamoError,
        });
        yield* deleteSessionsForShare(shareId);
        return { ...dynamoGrantToDomain(existing), revoked: true };
      }),

    createSession: (tripId, shareId, now = new Date()) =>
      Effect.tryPromise({
        try: async () => {
          const sessionId = generateSessionId();
          const expDate = new Date(
            now.getTime() + SHARE_SESSION_TTL_SECONDS * 1000,
          );
          const exp = normalizeInstant(expDate.toISOString());
          const ttl = Math.floor(expDate.getTime() / 1000);
          const item: DynamoShareSession = {
            PK: sessionPk(sessionId),
            SK: sessionSk(),
            GSI3PK: gsi3PkForTrip(tripId),
            GSI3SK: gsi3SkForSession(sessionId),
            GSI4PK: gsi4PkForShare(shareId),
            GSI4SK: gsi4SkForSession(sessionId),
            entityType: "SESSION",
            sessionId,
            tripId,
            shareId,
            exp,
            ttl,
          };
          await client.send(
            new PutCommand({
              TableName: tableName,
              Item: item,
            }),
          );
          return dynamoSessionToDomain(item);
        },
        catch: mapDynamoError,
      }),

    getSession: (sessionId) =>
      Effect.tryPromise({
        try: async () => {
          const result = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                PK: sessionPk(sessionId),
                SK: sessionSk(),
              },
            }),
          );
          if (result.Item === undefined) {
            return undefined;
          }
          return dynamoSessionToDomain(result.Item as DynamoShareSession);
        },
        catch: mapDynamoError,
      }),

    deleteSession: (sessionId) =>
      Effect.tryPromise({
        try: async () => {
          await client.send(
            new DeleteCommand({
              TableName: tableName,
              Key: {
                PK: sessionPk(sessionId),
                SK: sessionSk(),
              },
            }),
          );
        },
        catch: mapDynamoError,
      }),
  };
}
