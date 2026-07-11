import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors/app-error.js";
import { silentLogger } from "../logging/logger.js";
import { makeInMemoryTripRepo } from "../repos/trip-repo.js";
import {
  createTripDeleteWorkerHandler,
  deleteS3Keys,
  filterTripScopedS3Keys,
  isTripScopedS3Key,
  purgeSessionsForTrip,
  purgeTripPartitionChildren,
  runTripDeleteCascade,
  type CascadeResult,
} from "./trip-delete-worker.js";

describe("trip-delete-worker guards and helpers", () => {
  it("isTripScopedS3Key only allows trips/{tripId}/ prefix", () => {
    expect(isTripScopedS3Key("t1", "trips/t1/items/i1/a1")).toBe(true);
    expect(isTripScopedS3Key("t1", "trips/other/items/i1/a1")).toBe(false);
    expect(isTripScopedS3Key("t1", "evil/key")).toBe(false);
  });

  it("filterTripScopedS3Keys rejects outsiders", () => {
    const { allowed, rejected } = filterTripScopedS3Keys("t1", [
      "trips/t1/items/i1/a1",
      "trips/t2/x",
      "other",
    ]);
    expect(allowed).toEqual(["trips/t1/items/i1/a1"]);
    expect(rejected).toEqual(["trips/t2/x", "other"]);
  });

  it("createTripDeleteWorkerHandler runs cascade per SQS record", async () => {
    const seen: { tripId: string; ownerId: string }[] = [];
    const cascade = (message: {
      tripId: string;
      ownerId: string;
    }): Effect.Effect<CascadeResult, never> =>
      Effect.sync(() => {
        seen.push(message);
        return {
          sessionsDeleted: 0,
          childrenDeleted: 0,
          s3KeysFromMeta: [],
          s3KeysFromPrefix: 0,
        };
      });

    const handler = createTripDeleteWorkerHandler({
      tableName: "TripPlan-test",
      docsBucketName: "docs-test",
      logger: silentLogger,
      cascade,
    });

    await handler(
      {
        Records: [
          {
            messageId: "m1",
            receiptHandle: "r1",
            body: JSON.stringify({ tripId: "t1", ownerId: "o1" }),
            attributes: {
              ApproximateReceiveCount: "1",
              SentTimestamp: "0",
              SenderId: "x",
              ApproximateFirstReceiveTimestamp: "0",
            },
            messageAttributes: {},
            md5OfBody: "",
            eventSource: "aws:sqs",
            eventSourceARN: "arn:aws:sqs:us-east-1:1:q",
            awsRegion: "us-east-1",
          },
          {
            messageId: "m2",
            receiptHandle: "r2",
            body: JSON.stringify({ tripId: "t2", ownerId: "o1" }),
            attributes: {
              ApproximateReceiveCount: "1",
              SentTimestamp: "0",
              SenderId: "x",
              ApproximateFirstReceiveTimestamp: "0",
            },
            messageAttributes: {},
            md5OfBody: "",
            eventSource: "aws:sqs",
            eventSourceARN: "arn:aws:sqs:us-east-1:1:q",
            awsRegion: "us-east-1",
          },
        ],
      },
      {} as never,
      () => undefined,
    );

    expect(seen).toEqual([
      { tripId: "t1", ownerId: "o1" },
      { tripId: "t2", ownerId: "o1" },
    ]);
  });

  it("throws on invalid message body so SQS retries / DLQ", async () => {
    const handler = createTripDeleteWorkerHandler({
      tableName: "TripPlan-test",
      docsBucketName: "docs-test",
      logger: silentLogger,
      cascade: () =>
        Effect.succeed({
          sessionsDeleted: 0,
          childrenDeleted: 0,
          s3KeysFromMeta: [],
          s3KeysFromPrefix: 0,
        }),
    });

    await expect(
      handler(
        {
          Records: [
            {
              messageId: "bad",
              receiptHandle: "r",
              body: "not-json",
              attributes: {
                ApproximateReceiveCount: "1",
                SentTimestamp: "0",
                SenderId: "x",
                ApproximateFirstReceiveTimestamp: "0",
              },
              messageAttributes: {},
              md5OfBody: "",
              eventSource: "aws:sqs",
              eventSourceARN: "arn:aws:sqs:us-east-1:1:q",
              awsRegion: "us-east-1",
            },
          ],
        },
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow(/Invalid trip-delete message/);
  });

  it("skips purge when trip is still active", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      tripRepo.create("owner-1", {
        title: "Active",
        timezone: "UTC",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      }),
    );
    const ddb = {
      send: vi.fn(async () => {
        throw new Error("should not purge active");
      }),
    };
    const s3 = { send: vi.fn() };

    const result = await Effect.runPromise(
      runTripDeleteCascade(
        { tripId: created.tripId, ownerId: "owner-1" },
        {
          tableName: "TripPlan-test",
          docsBucketName: "docs-test",
          ddb: ddb as never,
          s3: s3 as never,
          tripRepo,
          logger: silentLogger,
        },
      ),
    );

    expect(result.skipped).toBe("not_deleting");
    expect(ddb.send).not.toHaveBeenCalled();
    const meta = await Effect.runPromise(tripRepo.getByTripId(created.tripId));
    expect(meta?.status).toBe("active");
  });

  it("skips purge on owner mismatch", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      tripRepo.create("owner-1", {
        title: "Owned",
        timezone: "UTC",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      }),
    );
    await Effect.runPromise(tripRepo.markDeleting("owner-1", created.tripId));
    const ddb = {
      send: vi.fn(async () => {
        throw new Error("should not purge wrong owner");
      }),
    };

    const result = await Effect.runPromise(
      runTripDeleteCascade(
        { tripId: created.tripId, ownerId: "attacker" },
        {
          tableName: "TripPlan-test",
          docsBucketName: "docs-test",
          ddb: ddb as never,
          s3: { send: vi.fn() } as never,
          tripRepo,
          logger: silentLogger,
        },
      ),
    );

    expect(result.skipped).toBe("owner_mismatch");
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("skips purge when meta missing", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const result = await Effect.runPromise(
      runTripDeleteCascade(
        { tripId: "gone", ownerId: "o1" },
        {
          tableName: "TripPlan-test",
          docsBucketName: "docs-test",
          ddb: { send: vi.fn() } as never,
          s3: { send: vi.fn() } as never,
          tripRepo,
          logger: silentLogger,
        },
      ),
    );
    expect(result.skipped).toBe("missing");
  });

  it("runTripDeleteCascade finalizes markDeleted for deleting trip", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      tripRepo.create("owner-1", {
        title: "Cascade",
        timezone: "UTC",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      }),
    );
    await Effect.runPromise(tripRepo.markDeleting("owner-1", created.tripId));

    const ddb = {
      send: vi.fn(async () => ({ Items: [], LastEvaluatedKey: undefined })),
    };
    const s3 = {
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return { Contents: [], IsTruncated: false };
        }
        return { Errors: [] };
      }),
    };

    const result = await Effect.runPromise(
      runTripDeleteCascade(
        { tripId: created.tripId, ownerId: "owner-1" },
        {
          tableName: "TripPlan-test",
          docsBucketName: "docs-test",
          ddb: ddb as never,
          s3: s3 as never,
          tripRepo,
          logger: silentLogger,
        },
      ),
    );

    expect(result.skipped).toBeUndefined();
    expect(result.sessionsDeleted).toBe(0);
    expect(result.childrenDeleted).toBe(0);
    const meta = await Effect.runPromise(
      tripRepo.getByTripId(created.tripId),
    );
    expect(meta?.status).toBe("deleted");
    expect(ddb.send).toHaveBeenCalled();
    expect(s3.send).toHaveBeenCalled();
  });

  it("deleteS3Keys fails when DeleteObjects returns Errors (no silent ack)", async () => {
    const s3 = {
      send: vi.fn(async () => ({
        Errors: [{ Key: "trips/t1/x", Code: "AccessDenied", Message: "nope" }],
      })),
    };

    const either = await Effect.runPromise(
      Effect.either(
        deleteS3Keys("bucket", ["trips/t1/x"], s3 as never),
      ),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left).toBeInstanceOf(AppError);
      expect(either.left.type).toBe("InternalError");
    }
  });

  it("purgeSessionsForTrip BatchWrites keys from GSI3 KEYS_ONLY items", async () => {
    const batchBodies: unknown[] = [];
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        if (cmd.constructor.name === "QueryCommand") {
          return {
            Items: [
              { PK: "SESSION#s1", SK: "META" },
              { PK: "SESSION#s2", SK: "META" },
            ],
            LastEvaluatedKey: undefined,
          };
        }
        if (cmd.constructor.name === "BatchWriteCommand") {
          batchBodies.push(cmd.input);
          return { UnprocessedItems: {} };
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      }),
    };

    const n = await Effect.runPromise(
      purgeSessionsForTrip("T", "trip-1", client as never),
    );
    expect(n).toBe(2);
    expect(batchBodies).toHaveLength(1);
    const input = batchBodies[0] as {
      RequestItems: { T: Array<{ DeleteRequest: { Key: { PK: string } } }> };
    };
    const pks = input.RequestItems.T.map((r) => r.DeleteRequest.Key.PK);
    expect(pks).toEqual(["SESSION#s1", "SESSION#s2"]);
  });

  it("purgeTripPartitionChildren collects scoped ATT keys and BatchWrites rows", async () => {
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "QueryCommand") {
          return {
            Items: [
              {
                PK: "TRIP#t1",
                SK: "SHARE#shr_1",
                entityType: "SHARE",
              },
              {
                PK: "TRIP#t1",
                SK: "ATT#i1#a1",
                entityType: "ATT",
                s3Key: "trips/t1/items/i1/a1",
              },
              {
                PK: "TRIP#t1",
                SK: "ATT#i1#evil",
                entityType: "ATT",
                s3Key: "other-bucket-path",
              },
              {
                PK: "TRIP#t1",
                SK: "ITEM#i1",
                entityType: "ITEM",
              },
            ],
            LastEvaluatedKey: undefined,
          };
        }
        if (cmd.constructor.name === "BatchWriteCommand") {
          return { UnprocessedItems: {} };
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      }),
    };

    const result = await Effect.runPromise(
      purgeTripPartitionChildren("T", "t1", client as never, silentLogger),
    );
    expect(result.deleted).toBe(4);
    expect(result.s3Keys).toEqual(["trips/t1/items/i1/a1"]);
  });
});
