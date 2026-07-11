import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "../auth/mock-owner-auth.js";
import type { HttpRequest } from "../http/types.js";
import { silentLogger } from "../logging/logger.js";
import {
  MAX_ITEMS_PER_TRIP,
  makeInMemoryTripRepo,
} from "../repos/trip-repo.js";
import { makeInMemoryUserRepo } from "../repos/user-repo.js";
import { handleRequest } from "../router.js";

function baseRequest(
  partial: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">,
): HttpRequest {
  return {
    method: partial.method,
    path: partial.path,
    url: partial.url ?? `https://plan.ericminassian.com${partial.path}`,
    headers: partial.headers ?? {},
    query: partial.query ?? {},
    cookies: partial.cookies ?? {},
    body: partial.body,
    requestId: partial.requestId ?? "test-request-id",
  };
}

const owner = mockPrincipal({ sub: "owner-1", nickname: "Ada" });
const other = mockPrincipal({ sub: "owner-2" });

function deps(
  tripRepo = makeInMemoryTripRepo(),
  principal: ReturnType<typeof mockPrincipal> | null = owner,
) {
  return {
    ownerAuth: makeMockOwnerAuth(principal),
    userRepo: makeInMemoryUserRepo(),
    tripRepo,
    logger: silentLogger,
  };
}

const tripBody = JSON.stringify({
  title: "Japan 2026",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
});

function noteBody(title: string, notes = "hello") {
  return JSON.stringify({
    type: "note",
    title,
    notes,
    details: {},
  });
}

function flightBody(title: string) {
  return JSON.stringify({
    type: "flight",
    title,
    startAt: "2026-06-01T10:00:00+09:00",
    endAt: "2026-06-01T14:00:00+09:00",
    details: {
      flightNumber: "100",
      airlineCode: "NH",
    },
  });
}

async function createTrip(
  tripRepo = makeInMemoryTripRepo(),
): Promise<{ tripRepo: ReturnType<typeof makeInMemoryTripRepo>; tripId: string; version: number }> {
  const res = await Effect.runPromise(
    handleRequest(
      baseRequest({ method: "POST", path: "/api/v1/trips", body: tripBody }),
      deps(tripRepo),
    ),
  );
  expect(res.status).toBe(201);
  const body = JSON.parse(res.body ?? "{}") as {
    tripId: string;
    version: number;
  };
  return { tripRepo, tripId: body.tripId, version: body.version };
}

async function createItem(
  tripRepo: ReturnType<typeof makeInMemoryTripRepo>,
  tripId: string,
  body: string,
  headers?: Record<string, string>,
) {
  return Effect.runPromise(
    handleRequest(
      baseRequest({
        method: "POST",
        path: `/api/v1/trips/${tripId}/items`,
        body,
        headers,
      }),
      deps(tripRepo),
    ),
  );
}

/** Current trip version (create/delete items bump trip version). */
async function tripVersion(
  tripRepo: ReturnType<typeof makeInMemoryTripRepo>,
  tripId: string,
): Promise<number> {
  const got = await Effect.runPromise(
    handleRequest(
      baseRequest({ method: "GET", path: `/api/v1/trips/${tripId}` }),
      deps(tripRepo),
    ),
  );
  expect(got.status).toBe(200);
  return (JSON.parse(got.body ?? "{}") as { version: number }).version;
}

describe("itinerary item CRUD + reorder", () => {
  it("POST creates item with server itemId, sortKey, version; GET trip orders by sortKey", async () => {
    const { tripRepo, tripId } = await createTrip();
    const a = await createItem(tripRepo, tripId, noteBody("A"));
    expect(a.status).toBe(201);
    const itemA = JSON.parse(a.body ?? "{}") as {
      itemId: string;
      tripId: string;
      type: string;
      sortKey: number;
      version: number;
      createdAt: string;
      title: string;
    };
    expect(itemA.tripId).toBe(tripId);
    expect(itemA.type).toBe("note");
    expect(itemA.sortKey).toBe(1000);
    expect(itemA.version).toBe(1);
    expect(itemA.itemId.length).toBeGreaterThan(0);
    expect(a.headers?.etag).toBe('"1"');

    const b = await createItem(tripRepo, tripId, flightBody("B"));
    expect(b.status).toBe(201);
    const itemB = JSON.parse(b.body ?? "{}") as { sortKey: number };
    expect(itemB.sortKey).toBe(2000);

    const got = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: `/api/v1/trips/${tripId}` }),
        deps(tripRepo),
      ),
    );
    expect(got.status).toBe(200);
    const detail = JSON.parse(got.body ?? "{}") as {
      items: { title: string; sortKey: number }[];
    };
    expect(detail.items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(detail.items.map((i) => i.sortKey)).toEqual([1000, 2000]);
  });

  it("optional Idempotency-Key replays live item; rejects key > 128; cross-trip 409", async () => {
    const { tripRepo, tripId } = await createTrip();
    const first = await createItem(tripRepo, tripId, noteBody("Idem"), {
      "idempotency-key": "key-1",
    });
    expect(first.status).toBe(201);
    const firstBody = JSON.parse(first.body ?? "{}") as {
      itemId: string;
      version: number;
    };

    // PATCH then replay → live version/title (not create-time snapshot).
    const patched = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${firstBody.itemId}`,
          headers: { "if-match": `"${firstBody.version}"` },
          body: JSON.stringify({ title: "Patched title" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(patched.status).toBe(200);

    const second = await createItem(tripRepo, tripId, noteBody("Idem other"), {
      "idempotency-key": "key-1",
    });
    expect(second.status).toBe(201);
    const secondBody = JSON.parse(second.body ?? "{}") as {
      itemId: string;
      title: string;
      version: number;
    };
    expect(secondBody.itemId).toBe(firstBody.itemId);
    expect(secondBody.title).toBe("Patched title");
    expect(secondBody.version).toBe(2);

    const tooLong = await createItem(tripRepo, tripId, noteBody("X"), {
      "idempotency-key": "k".repeat(129),
    });
    expect(tooLong.status).toBe(400);

    // Same key on another trip → 409 (do not create a second item).
    const otherTrip = await createTrip(tripRepo);
    const cross = await createItem(
      tripRepo,
      otherTrip.tripId,
      noteBody("Cross"),
      { "idempotency-key": "key-1" },
    );
    expect(cross.status).toBe(409);

    // After delete, replay → 404 (no ghost snapshot).
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/items/${firstBody.itemId}`,
        }),
        deps(tripRepo),
      ),
    );
    const afterDelete = await createItem(tripRepo, tripId, noteBody("Gone"), {
      "idempotency-key": "key-1",
    });
    expect(afterDelete.status).toBe(404);
  });

  it("enforces max 100 items per trip", async () => {
    const { tripRepo, tripId } = await createTrip();
    for (let i = 0; i < MAX_ITEMS_PER_TRIP; i += 1) {
      const res = await createItem(tripRepo, tripId, noteBody(`N${i}`));
      expect(res.status).toBe(201);
    }
    const over = await createItem(tripRepo, tripId, noteBody("overflow"));
    expect(over.status).toBe(400);
    const body = JSON.parse(over.body ?? "{}") as { type: string; message: string };
    expect(body.type).toBe("ValidationError");
    expect(body.message).toMatch(/limit/i);
  });

  it("PATCH requires If-Match on item; rejects type and expectedVersion; 409 on stale", async () => {
    const { tripRepo, tripId } = await createTrip();
    const created = await createItem(tripRepo, tripId, noteBody("Old"));
    const item = JSON.parse(created.body ?? "{}") as {
      itemId: string;
      version: number;
    };

    const noMatch = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
          body: JSON.stringify({ title: "New" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(noMatch.status).toBe(400);

    const typeChange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
          headers: { "if-match": `"${item.version}"` },
          body: JSON.stringify({ type: "flight", title: "X" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(typeChange.status).toBe(400);
    const typeErr = JSON.parse(typeChange.body ?? "{}") as { message: string };
    expect(typeErr.message).toMatch(/immutable|validation/i);

    const withExpected = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
          headers: { "if-match": `"${item.version}"` },
          body: JSON.stringify({ title: "New", expectedVersion: 1 }),
        }),
        deps(tripRepo),
      ),
    );
    expect(withExpected.status).toBe(400);

    const ok = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
          headers: { "if-match": `"${item.version}"` },
          body: JSON.stringify({ title: "Updated" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(ok.status).toBe(200);
    const updated = JSON.parse(ok.body ?? "{}") as {
      title: string;
      version: number;
      type: string;
    };
    expect(updated.title).toBe("Updated");
    expect(updated.version).toBe(2);
    expect(updated.type).toBe("note");
    expect(ok.headers?.etag).toBe('"2"');

    const conflict = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
          headers: { "if-match": '"1"' },
          body: JSON.stringify({ title: "Stale" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(conflict.status).toBe(409);
    const cbody = JSON.parse(conflict.body ?? "{}") as {
      type: string;
      details: { version: number };
    };
    expect(cbody.type).toBe("Conflict");
    expect(cbody.details.version).toBe(2);
  });

  it("DELETE removes item; second delete 404; foreign owner 404", async () => {
    const { tripRepo, tripId } = await createTrip();
    const created = await createItem(tripRepo, tripId, noteBody("Del"));
    const item = JSON.parse(created.body ?? "{}") as { itemId: string };

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(del.status).toBe(204);

    const got = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: `/api/v1/trips/${tripId}` }),
        deps(tripRepo),
      ),
    );
    const detail = JSON.parse(got.body ?? "{}") as { items: unknown[] };
    expect(detail.items).toEqual([]);

    const again = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/items/${item.itemId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(again.status).toBe(404);

    // recreate for foreign check
    const otherItem = await createItem(tripRepo, tripId, noteBody("Mine"));
    const oid = (JSON.parse(otherItem.body ?? "{}") as { itemId: string }).itemId;
    const foreign = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/items/${oid}`,
        }),
        deps(tripRepo, other),
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("reorder: full permutation, trip If-Match, sortKeys 1000/2000/…, 409 stale trip", async () => {
    const { tripRepo, tripId } = await createTrip();
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const res = await createItem(tripRepo, tripId, noteBody(title));
      ids.push(
        (JSON.parse(res.body ?? "{}") as { itemId: string }).itemId,
      );
    }
    // Creates bump trip version (1 → 4 after 3 items).
    const version = await tripVersion(tripRepo, tripId);
    expect(version).toBe(4);

    const reversed = [...ids].reverse();
    const reordered = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${version}"` },
          body: JSON.stringify({ itemIds: reversed }),
        }),
        deps(tripRepo),
      ),
    );
    expect(reordered.status).toBe(200);
    const body = JSON.parse(reordered.body ?? "{}") as {
      version: number;
      items: { itemId: string; sortKey: number; title: string }[];
    };
    expect(body.version).toBe(version + 1);
    expect(body.items.map((i) => i.itemId)).toEqual(reversed);
    expect(body.items.map((i) => i.sortKey)).toEqual([1000, 2000, 3000]);
    expect(reordered.headers?.etag).toBe(`"${version + 1}"`);

    // GET confirms order
    const got = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: `/api/v1/trips/${tripId}` }),
        deps(tripRepo),
      ),
    );
    const detail = JSON.parse(got.body ?? "{}") as {
      items: { title: string }[];
    };
    expect(detail.items.map((i) => i.title)).toEqual(["C", "B", "A"]);

    // Stale trip version → 409
    const conflict = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${version}"` },
          body: JSON.stringify({ itemIds: reversed }),
        }),
        deps(tripRepo),
      ),
    );
    expect(conflict.status).toBe(409);

    // Incomplete permutation → 400
    const bad = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${body.version}"` },
          body: JSON.stringify({ itemIds: [ids[0], ids[1]] }),
        }),
        deps(tripRepo),
      ),
    );
    expect(bad.status).toBe(400);
  });

  it("PATCH after reorder preserves sortKey (does not clobber)", async () => {
    const { tripRepo, tripId } = await createTrip();
    const ids: string[] = [];
    for (const title of ["A", "B"]) {
      const res = await createItem(tripRepo, tripId, noteBody(title));
      ids.push(
        (JSON.parse(res.body ?? "{}") as { itemId: string }).itemId,
      );
    }
    const v = await tripVersion(tripRepo, tripId);
    const reversed = [...ids].reverse();
    const reordered = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${v}"` },
          body: JSON.stringify({ itemIds: reversed }),
        }),
        deps(tripRepo),
      ),
    );
    expect(reordered.status).toBe(200);
    const order = JSON.parse(reordered.body ?? "{}") as {
      items: { itemId: string; sortKey: number; version: number }[];
    };
    const first = order.items[0];
    if (first === undefined) {
      throw new Error("expected item");
    }
    expect(first.sortKey).toBe(1000);

    const patch = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${tripId}/items/${first.itemId}`,
          headers: { "if-match": `"${first.version}"` },
          body: JSON.stringify({ title: "Renamed" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(patch.status).toBe(200);
    const patched = JSON.parse(patch.body ?? "{}") as {
      title: string;
      sortKey: number;
    };
    expect(patched.title).toBe("Renamed");
    expect(patched.sortKey).toBe(1000);
  });

  it("create/delete bump trip version so stale reorder If-Match fails", async () => {
    const { tripRepo, tripId, version: v0 } = await createTrip();
    expect(v0).toBe(1);
    const a = await createItem(tripRepo, tripId, noteBody("A"));
    const b = await createItem(tripRepo, tripId, noteBody("B"));
    const idA = (JSON.parse(a.body ?? "{}") as { itemId: string }).itemId;
    const idB = (JSON.parse(b.body ?? "{}") as { itemId: string }).itemId;
    const afterCreates = await tripVersion(tripRepo, tripId);
    expect(afterCreates).toBe(3);

    // Stale If-Match from before creates → 409
    const stale = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${v0}"` },
          body: JSON.stringify({ itemIds: [idB, idA] }),
        }),
        deps(tripRepo),
      ),
    );
    expect(stale.status).toBe(409);

    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/items/${idB}`,
        }),
        deps(tripRepo),
      ),
    );
    const afterDelete = await tripVersion(tripRepo, tripId);
    expect(afterDelete).toBe(4);
  });

  it("reorder 100 items in-memory (chunk algorithm path)", async () => {
    const { tripRepo, tripId } = await createTrip();
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await createItem(tripRepo, tripId, noteBody(`N${i}`));
      expect(res.status).toBe(201);
      ids.push(
        (JSON.parse(res.body ?? "{}") as { itemId: string }).itemId,
      );
    }
    const version = await tripVersion(tripRepo, tripId);
    expect(version).toBe(101); // 1 + 100 creates
    const permuted = [...ids].reverse();
    const res = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items/reorder`,
          headers: { "if-match": `"${version}"` },
          body: JSON.stringify({ itemIds: permuted }),
        }),
        deps(tripRepo),
      ),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body ?? "{}") as {
      items: { itemId: string; sortKey: number }[];
      version: number;
    };
    expect(body.items).toHaveLength(100);
    expect(body.items[0]?.itemId).toBe(permuted[0]);
    expect(body.items[0]?.sortKey).toBe(1000);
    expect(body.items[99]?.sortKey).toBe(100_000);
    expect(body.items[24]?.sortKey).toBe(25_000);
    expect(body.version).toBe(version + 1);
  });

  it("create on missing trip / foreign trip returns 404", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const missing = await createItem(
      tripRepo,
      crypto.randomUUID(),
      noteBody("X"),
    );
    expect(missing.status).toBe(404);

    const { tripId } = await createTrip(tripRepo);
    const foreign = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items`,
          body: noteBody("X"),
        }),
        deps(tripRepo, other),
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("export includes items ordered by sortKey", async () => {
    const { tripRepo, tripId } = await createTrip();
    await createItem(tripRepo, tripId, noteBody("One"));
    await createItem(tripRepo, tripId, noteBody("Two"));
    const exp = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${tripId}/export`,
        }),
        deps(tripRepo),
      ),
    );
    expect(exp.status).toBe(200);
    const body = JSON.parse(exp.body ?? "{}") as {
      items: { title: string }[];
    };
    expect(body.items.map((i) => i.title)).toEqual(["One", "Two"]);
  });
});
