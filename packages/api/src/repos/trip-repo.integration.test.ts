/**
 * DynamoDB integration tests for access patterns 1 (list) and 2a (get meta).
 *
 * Gated on `TRIPPLAN_IT_TABLE` — when unset, the suite no-ops so CI unit tests pass.
 * Optional: `AWS_REGION` (default us-east-1). Requires credentials with table R/W.
 */
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeDynamoTripRepo, tripSk, userPk } from "./dynamo-trip-repo.js";

const tableName = process.env.TRIPPLAN_IT_TABLE?.trim();
const describeIt =
  tableName !== undefined && tableName.length > 0 ? describe : describe.skip;

describeIt("DynamoDB trip access patterns (1, 2a)", () => {
  const table = tableName as string;
  const repo = makeDynamoTripRepo(table);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ownerId = `it-owner-${crypto.randomUUID()}`;

  it("2a: create + getActiveForOwner; GSI1 keys present; unknown id undefined", async () => {
    const created = await Effect.runPromise(
      repo.create(ownerId, {
        title: "IT Trip",
        timezone: "America/Los_Angeles",
        startDate: "2026-07-01",
        endDate: "2026-07-08",
      }),
    );
    expect(created.ownerId).toBe(ownerId);
    expect(created.version).toBe(1);
    expect(created.status).toBe("active");

    // Base GetItem + GSI1 attribute assertion (access pattern 2a / share prep).
    const base = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { PK: userPk(ownerId), SK: tripSk(created.tripId) },
      }),
    );
    expect(base.Item).toBeDefined();
    expect(base.Item?.GSI1PK).toBe(`TRIP#${created.tripId}`);
    expect(base.Item?.GSI1SK).toBe("META");
    expect(base.Item?.entityType).toBe("TRIP");
    expect(base.Item?.status).toBe("active");

    const gsi = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
        ExpressionAttributeValues: {
          ":pk": `TRIP#${created.tripId}`,
          ":sk": "META",
        },
      }),
    );
    expect(gsi.Items?.length).toBe(1);
    expect(gsi.Items?.[0]?.ownerId).toBe(ownerId);

    const got = await Effect.runPromise(
      repo.getActiveForOwner(ownerId, created.tripId),
    );
    expect(got).toBeDefined();
    expect(got?.tripId).toBe(created.tripId);
    expect(got?.title).toBe("IT Trip");

    const missing = await Effect.runPromise(
      repo.getActiveForOwner(ownerId, crypto.randomUUID()),
    );
    expect(missing).toBeUndefined();

    await Effect.runPromise(repo.softDelete(ownerId, created.tripId));
    const afterDelete = await Effect.runPromise(
      repo.getActiveForOwner(ownerId, created.tripId),
    );
    expect(afterDelete).toBeUndefined();
  });

  it("1: list pages cover all actives with no skips/duplicates", async () => {
    const owner = `it-list-${crypto.randomUUID()}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = await Effect.runPromise(
        repo.create(owner, {
          title: `List ${i}`,
          timezone: "UTC",
          startDate: "2026-01-01",
          endDate: "2026-01-02",
        }),
      );
      ids.push(t.tripId);
    }
    await Effect.runPromise(repo.softDelete(owner, ids[0] as string));
    const expectedActive = new Set(ids.slice(1));

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await Effect.runPromise(
        repo.listActiveForOwner(owner, { limit: 2, cursor }),
      );
      for (const t of page.trips) {
        collected.push(t.tripId);
        expect(t.status).toBe("active");
      }
      if (page.nextCursor === undefined) {
        break;
      }
      cursor = page.nextCursor;
    }

    expect(new Set(collected)).toEqual(expectedActive);
    expect(collected).toHaveLength(expectedActive.size);
    expect(collected).not.toContain(ids[0]);
  });
});

describeIt("DynamoDB item access patterns (2b, create, reorder)", () => {
  const table = tableName as string;
  const repo = makeDynamoTripRepo(table);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  it("create items + list ordered by sortKey; SK is ITEM#itemId only", async () => {
    const ownerId = `it-items-${crypto.randomUUID()}`;
    const trip = await Effect.runPromise(
      repo.create(ownerId, {
        title: "Items IT",
        timezone: "UTC",
        startDate: "2026-01-01",
        endDate: "2026-01-05",
      }),
    );

    const a = await Effect.runPromise(
      repo.createItem(ownerId, trip.tripId, {
        type: "note",
        title: "A",
        details: {},
      }),
    );
    const b = await Effect.runPromise(
      repo.createItem(ownerId, trip.tripId, {
        type: "note",
        title: "B",
        details: {},
      }),
    );
    expect(a.sortKey).toBe(1000);
    expect(b.sortKey).toBe(2000);

    const raw = await doc.send(
      new GetCommand({
        TableName: table,
        Key: {
          PK: `TRIP#${trip.tripId}`,
          SK: `ITEM#${a.itemId}`,
        },
      }),
    );
    expect(raw.Item?.SK).toBe(`ITEM#${a.itemId}`);
    expect(raw.Item?.sortKey).toBe(1000);
    expect(raw.Item?.ownerId).toBe(ownerId);
    // Never encode sortKey in SK
    expect(String(raw.Item?.SK)).not.toContain("1000");

    const listed = await Effect.runPromise(
      repo.listItems(ownerId, trip.tripId),
    );
    expect(listed.map((i) => i.title)).toEqual(["A", "B"]);

    const reordered = await Effect.runPromise(
      repo.reorderItems(ownerId, trip.tripId, trip.version, [
        b.itemId,
        a.itemId,
      ]),
    );
    expect(reordered.trip.version).toBe(trip.version + 1);
    expect(reordered.items.map((i) => i.itemId)).toEqual([b.itemId, a.itemId]);
    expect(reordered.items.map((i) => i.sortKey)).toEqual([1000, 2000]);
  });
});

describe("DynamoDB trip IT gate", () => {
  it("documents TRIPPLAN_IT_TABLE skip behavior", () => {
    if (tableName === undefined || tableName.length === 0) {
      expect(tableName === undefined || tableName.length === 0).toBe(true);
    } else {
      expect(tableName.length).toBeGreaterThan(0);
    }
  });
});
