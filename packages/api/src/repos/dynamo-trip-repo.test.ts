import {
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  accumulateActivePage,
  domainItemToDynamo,
  dynamoItemToDomain,
  encodeCursor,
  itemSk,
  itemToTrip,
  makeDynamoTripRepo,
  parseListCursor,
  tripItemsPk,
  tripSk,
  userPk,
  type TripItem,
} from "./dynamo-trip-repo.js";

function tripItem(
  ownerId: string,
  tripId: string,
  status: TripItem["status"] = "active",
  version = 1,
): TripItem {
  return {
    PK: userPk(ownerId),
    SK: tripSk(tripId),
    GSI1PK: `TRIP#${tripId}`,
    GSI1SK: "META",
    entityType: "TRIP",
    tripId,
    ownerId,
    title: `T-${tripId}`,
    timezone: "UTC",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    version,
    status,
  };
}

describe("parseListCursor", () => {
  it("accepts PK/SK for the owner", () => {
    const cursor = encodeCursor({
      PK: userPk("o1"),
      SK: tripSk("t1"),
    });
    expect(parseListCursor(cursor, "o1")).toEqual({
      PK: "USER#o1",
      SK: "TRIP#t1",
    });
  });

  it("rejects wrong owner, missing keys, garbage", () => {
    const wrongOwner = encodeCursor({
      PK: userPk("other"),
      SK: tripSk("t1"),
    });
    expect(() => parseListCursor(wrongOwner, "o1")).toThrow();
    expect(() => parseListCursor("not-base64-json!!!", "o1")).toThrow();
    const noSk = encodeCursor({ PK: userPk("o1") });
    expect(() => parseListCursor(noSk, "o1")).toThrow();
  });
});

describe("accumulateActivePage (cursor completeness)", () => {
  const owner = "owner-a";
  const items = ["a", "b", "c", "d", "e"].map((id) => tripItem(owner, id));

  it("mid-page consume: cursor is last returned item, not batch LEK", () => {
    // Single query returns 3 actives, limit=2 → residual "c" must not be skipped.
    const page = accumulateActivePage({
      limit: 2,
      batches: [
        {
          items: items.slice(0, 3),
          lastEvaluatedKey: undefined,
        },
      ],
    });
    expect(page.trips.map((t) => t.tripId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe(
      encodeCursor({ PK: userPk(owner), SK: tripSk("b") }),
    );
  });

  it("final partition page with more matches than limit still has nextCursor", () => {
    const page = accumulateActivePage({
      limit: 2,
      batches: [
        {
          items: items.slice(0, 3),
          lastEvaluatedKey: undefined,
        },
      ],
    });
    expect(page.nextCursor).toBeDefined();

    // Simulate second page starting after "b".
    const page2 = accumulateActivePage({
      limit: 2,
      batches: [
        {
          items: items.slice(2), // c, d, e
          lastEvaluatedKey: undefined,
        },
      ],
    });
    expect(page2.trips.map((t) => t.tripId)).toEqual(["c", "d"]);
    expect(page2.nextCursor).toBe(
      encodeCursor({ PK: userPk(owner), SK: tripSk("d") }),
    );

    const page3 = accumulateActivePage({
      limit: 2,
      batches: [
        {
          items: items.slice(4), // e
          lastEvaluatedKey: undefined,
        },
      ],
    });
    expect(page3.trips.map((t) => t.tripId)).toEqual(["e"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("exact batch fill uses LEK when present", () => {
    const lek = { PK: userPk(owner), SK: tripSk("b") };
    const page = accumulateActivePage({
      limit: 2,
      batches: [
        {
          items: items.slice(0, 2),
          lastEvaluatedKey: lek,
        },
      ],
    });
    expect(page.trips.map((t) => t.tripId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe(encodeCursor(lek));
  });
});

/**
 * Minimal DocumentClient double for list/get/update/delete CCF paths.
 */
function makeMockClient(store: Map<string, TripItem>): DynamoDBDocumentClient {
  const keyOf = (pk: string, sk: string) => `${pk}\0${sk}`;

  return {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        const input = command.input;
        const pk = input.ExpressionAttributeValues?.[":pk"] as string;
        const skPrefix = input.ExpressionAttributeValues?.[":sk"] as string;
        const activeOnly =
          input.FilterExpression?.includes(":active") === true;
        const start = input.ExclusiveStartKey as
          | { PK?: string; SK?: string }
          | undefined;

        let rows = [...store.values()]
          .filter((i) => i.PK === pk && i.SK.startsWith(skPrefix))
          .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));

        if (start?.SK !== undefined) {
          rows = rows.filter((r) => r.SK > (start.SK as string));
        }

        const limit = input.Limit ?? rows.length;
        // Simulate FilterExpression after Limit: take up to `limit` raw, then filter.
        const rawSlice = rows.slice(0, limit);
        const evaluated = activeOnly
          ? rawSlice.filter((r) => r.status === "active")
          : rawSlice;
        const lastRaw = rawSlice[rawSlice.length - 1];
        const hasMore = rows.length > rawSlice.length;

        if (input.Select === "COUNT") {
          return {
            Count: evaluated.length,
            LastEvaluatedKey: hasMore && lastRaw
              ? { PK: lastRaw.PK, SK: lastRaw.SK }
              : undefined,
          };
        }

        return {
          Items: evaluated,
          LastEvaluatedKey:
            hasMore && lastRaw
              ? { PK: lastRaw.PK, SK: lastRaw.SK }
              : undefined,
        };
      }

      if (command instanceof GetCommand) {
        const pk = command.input.Key?.PK as string;
        const sk = command.input.Key?.SK as string;
        const item = store.get(keyOf(pk, sk));
        return { Item: item };
      }

      if (command instanceof PutCommand) {
        const item = command.input.Item as TripItem;
        store.set(keyOf(item.PK, item.SK), item);
        return {};
      }

      if (command instanceof UpdateCommand) {
        const pk = command.input.Key?.PK as string;
        const sk = command.input.Key?.SK as string;
        const existing = store.get(keyOf(pk, sk));
        if (existing === undefined) {
          throw new ConditionalCheckFailedException({
            message: "missing",
            $metadata: {},
          });
        }

        const cond = command.input.ConditionExpression ?? "";
        const values = command.input.ExpressionAttributeValues ?? {};

        if (cond.includes("#status = :active") && existing.status !== "active") {
          throw new ConditionalCheckFailedException({
            message: "not active",
            $metadata: {},
          });
        }
        if (
          cond.includes("#status = :deleted") &&
          !cond.includes("<>") &&
          existing.status !== "deleted"
        ) {
          throw new ConditionalCheckFailedException({
            message: "not deleted",
            $metadata: {},
          });
        }
        if (
          cond.includes("#status <> :deleted") &&
          existing.status === "deleted"
        ) {
          throw new ConditionalCheckFailedException({
            message: "already deleted",
            $metadata: {},
          });
        }
        if (cond.includes("#ver = :ev")) {
          const expected = values[":ev"];
          if (existing.version !== expected) {
            throw new ConditionalCheckFailedException({
              message: "version",
              $metadata: {},
            });
          }
        }

        const updated: TripItem = {
          ...existing,
          title: (values[":title"] as string | undefined) ?? existing.title,
          timezone: (values[":tz"] as string | undefined) ?? existing.timezone,
          startDate: (values[":sd"] as string | undefined) ?? existing.startDate,
          endDate: (values[":ed"] as string | undefined) ?? existing.endDate,
          status:
            (values[":deleting"] as TripItem["status"] | undefined) ??
            (values[":deleted"] as TripItem["status"] | undefined) ??
            existing.status,
          deletedAt:
            (values[":da"] as string | undefined) ?? existing.deletedAt,
          ttl:
            (values[":ttl"] as number | undefined) ?? existing.ttl,
          version:
            values[":nv"] !== undefined
              ? (values[":nv"] as number)
              : values[":one"] !== undefined
                ? existing.version + (values[":one"] as number)
                : existing.version,
        };
        store.set(keyOf(pk, sk), updated);
        return {
          Attributes:
            command.input.ReturnValues === "ALL_NEW" ? updated : undefined,
        };
      }

      throw new Error(`Unexpected command: ${String(command)}`);
    },
  } as DynamoDBDocumentClient;
}

describe("makeDynamoTripRepo list cursor (mock client)", () => {
  it("concatenated pages equal full active set with no duplicates", async () => {
    const owner = "list-owner";
    const store = new Map<string, TripItem>();
    // Mix deleted so FilterExpression path matters.
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
      const item = tripItem(owner, id, id === "t3" ? "deleted" : "active");
      store.set(`${item.PK}\0${item.SK}`, item);
    }
    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await Effect.runPromise(
        repo.listActiveForOwner(owner, { limit: 2, cursor }),
      );
      for (const t of result.trips) {
        collected.push(t.tripId);
      }
      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    expect(collected).toEqual(["t1", "t2", "t4", "t5"]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("limit=1 walks every active trip", async () => {
    const owner = "walk-owner";
    const store = new Map<string, TripItem>();
    for (const id of ["a", "b", "c"]) {
      const item = tripItem(owner, id);
      store.set(`${item.PK}\0${item.SK}`, item);
    }
    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await Effect.runPromise(
        repo.listActiveForOwner(owner, { limit: 1, cursor }),
      );
      expect(result.trips).toHaveLength(1);
      collected.push(result.trips[0]?.tripId as string);
      cursor = result.nextCursor;
    } while (cursor !== undefined);

    expect(collected).toEqual(["a", "b", "c"]);
  });
});

describe("makeDynamoTripRepo update CCF re-Get", () => {
  it("returns 409 with live version after concurrent write", async () => {
    const owner = "ccf-owner";
    const tripId = "trip-1";
    const store = new Map<string, TripItem>();
    const item = tripItem(owner, tripId, "active", 1);
    store.set(`${item.PK}\0${item.SK}`, item);

    let updateCalls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          const pk = command.input.Key?.PK as string;
          const sk = command.input.Key?.SK as string;
          return { Item: store.get(`${pk}\0${sk}`) };
        }
        if (command instanceof UpdateCommand) {
          updateCalls += 1;
          if (updateCalls === 1) {
            // Concurrent PATCH already moved version to 2.
            const cur = store.get(`${item.PK}\0${item.SK}`);
            if (cur !== undefined) {
              store.set(`${item.PK}\0${item.SK}`, { ...cur, version: 2 });
            }
            throw new ConditionalCheckFailedException({
              message: "version",
              $metadata: {},
            });
          }
        }
        throw new Error("unexpected");
      },
    } as DynamoDBDocumentClient;

    const repo = makeDynamoTripRepo("TripPlan-test", client);
    const result = await Effect.runPromise(
      Effect.either(
        repo.update(owner, tripId, 1, { title: "Nope" }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.type).toBe("Conflict");
      expect(
        (result.left.details as { version: number } | undefined)?.version,
      ).toBe(2);
    }
  });
});

describe("makeDynamoTripRepo markDeleting status-only condition", () => {
  it("succeeds when version moved but status still active", async () => {
    const owner = "del-owner";
    const tripId = "trip-del";
    const store = new Map<string, TripItem>();
    // Pre-image version 1; concurrent patch made version 5 before delete.
    const item = tripItem(owner, tripId, "active", 5);
    store.set(`${item.PK}\0${item.SK}`, item);

    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));
    const deleting = await Effect.runPromise(repo.markDeleting(owner, tripId));
    expect(deleting.status).toBe("deleting");
    expect(deleting.version).toBe(6);
    expect(deleting.deletedAt).toBeDefined();
  });

  it("is idempotent when already deleting", async () => {
    const owner = "del-owner-2";
    const tripId = "trip-del-2";
    const store = new Map<string, TripItem>();
    const item = {
      ...tripItem(owner, tripId, "deleting", 3),
      deletedAt: "2026-07-01T00:00:00.000Z",
    };
    store.set(`${item.PK}\0${item.SK}`, item);

    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));
    const again = await Effect.runPromise(repo.markDeleting(owner, tripId));
    expect(again.status).toBe("deleting");
    expect(again.version).toBe(3);
  });
});

describe("makeDynamoTripRepo markDeleted ttl backfill", () => {
  it("backfills ttl when already deleted without ttl (pre-PR15 migrate)", async () => {
    const owner = "ttl-owner";
    const tripId = "trip-ttl";
    const store = new Map<string, TripItem>();
    const item = {
      ...tripItem(owner, tripId, "deleted", 2),
      deletedAt: "2026-06-01T00:00:00.000Z",
      // no ttl — interim soft-delete
    };
    store.set(`${item.PK}\0${item.SK}`, item);

    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));
    const result = await Effect.runPromise(repo.markDeleted(owner, tripId));
    expect(result.status).toBe("deleted");
    const stored = store.get(`${item.PK}\0${item.SK}`);
    expect(stored?.ttl).toBeTypeOf("number");
    expect(stored?.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("is pure no-op when deleted and ttl already set", async () => {
    const owner = "ttl-owner-2";
    const tripId = "trip-ttl-2";
    const store = new Map<string, TripItem>();
    const item = {
      ...tripItem(owner, tripId, "deleted", 4),
      deletedAt: "2026-06-01T00:00:00.000Z",
      ttl: 2_000_000_000,
    };
    store.set(`${item.PK}\0${item.SK}`, item);

    const repo = makeDynamoTripRepo("TripPlan-test", makeMockClient(store));
    const result = await Effect.runPromise(repo.markDeleted(owner, tripId));
    expect(result.status).toBe("deleted");
    expect(result.version).toBe(4);
    expect(store.get(`${item.PK}\0${item.SK}`)?.ttl).toBe(2_000_000_000);
  });
});

describe("itemToTrip", () => {
  it("maps domain fields", () => {
    const t = itemToTrip(tripItem("o", "x"));
    expect(t.tripId).toBe("x");
    expect(t.ownerId).toBe("o");
  });
});

describe("domainItemToDynamo / dynamoItemToDomain", () => {
  it("round-trips note item with SK=ITEM#itemId and sortKey attribute", () => {
    const domain = {
      itemId: "item-1",
      tripId: "trip-1",
      type: "note" as const,
      title: "Hello",
      details: {},
      sortKey: 2000,
      version: 1,
      createdAt: "2026-07-10T12:00:00Z",
      updatedAt: "2026-07-10T12:00:00Z",
      notes: "body",
    };
    const row = domainItemToDynamo("owner-1", domain);
    expect(row.PK).toBe(tripItemsPk("trip-1"));
    expect(row.SK).toBe(itemSk("item-1"));
    expect(row.SK).toBe("ITEM#item-1");
    expect(row.sortKey).toBe(2000);
    expect(row.ownerId).toBe("owner-1");
    expect(row.entityType).toBe("ITEM");
    const back = dynamoItemToDomain(row);
    expect(back.itemId).toBe("item-1");
    expect(back.sortKey).toBe(2000);
    expect(back.type).toBe("note");
    expect(back.notes).toBe("body");
  });
});

describe("buildItemPatchUpdateExpression never writes sortKey", () => {
  it("SET expression omits sortKey", async () => {
    const { buildItemPatchUpdateExpression } = await import("./item-build.js");
    const existing = {
      itemId: "i1",
      tripId: "t1",
      type: "note" as const,
      title: "Old",
      details: {},
      sortKey: 5000,
      version: 1,
      createdAt: "2026-07-10T12:00:00Z",
      updatedAt: "2026-07-10T12:00:00Z",
    };
    const parts = buildItemPatchUpdateExpression(
      existing,
      { title: "New" },
      1,
      "2026-07-10T13:00:00Z",
    );
    expect(parts.updateExpression).toContain("title = :title");
    expect(parts.updateExpression).not.toMatch(/sortKey/i);
    expect(Object.keys(parts.expressionAttributeValues).join(",")).not.toMatch(
      /sortKey/i,
    );
    expect(parts.newVersion).toBe(2);
  });

  it("null startAt/endAt emit REMOVE clauses", async () => {
    const { buildItemPatchUpdateExpression } = await import("./item-build.js");
    const existing = {
      itemId: "i1",
      tripId: "t1",
      type: "note" as const,
      title: "Old",
      startAt: "2026-06-01T10:00:00Z",
      endAt: "2026-06-01T12:00:00Z",
      details: {},
      sortKey: 1000,
      version: 1,
      createdAt: "2026-07-10T12:00:00Z",
      updatedAt: "2026-07-10T12:00:00Z",
    };
    const parts = buildItemPatchUpdateExpression(
      existing,
      { startAt: null, endAt: null },
      1,
      "2026-07-10T13:00:00Z",
    );
    expect(parts.updateExpression).toMatch(/REMOVE startAt, endAt|REMOVE endAt, startAt/);
    expect(parts.updateExpression).not.toContain(":startAt");
    expect(parts.updateExpression).not.toContain(":endAt");
  });
});
