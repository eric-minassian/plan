import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "../auth/mock-owner-auth.js";
import type { HttpRequest } from "../http/types.js";
import { silentLogger } from "../logging/logger.js";
import {
  makeInMemoryTripRepo,
  MAX_ACTIVE_TRIPS_PER_OWNER,
} from "../repos/trip-repo.js";
import { makeInMemoryUserRepo } from "../repos/user-repo.js";
import { buildRoutes, handleRequest } from "../router.js";

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
    clientIp: partial.clientIp ?? "127.0.0.1",
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

const createBody = JSON.stringify({
  title: "Japan 2026",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
});

describe("trip CRUD routes", () => {
  it("registers owner auth on all trip routes", () => {
    for (const route of buildRoutes()) {
      if (route.path.startsWith("/api/v1/trips")) {
        expect(route.authClass).toBe("owner");
      }
    }
  });

  it("POST /api/v1/trips creates a trip for the owner", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    expect(response.status).toBe(201);
    const body = JSON.parse(response.body ?? "{}") as {
      tripId: string;
      ownerId: string;
      title: string;
      version: number;
      status: string;
    };
    expect(body.ownerId).toBe("owner-1");
    expect(body.title).toBe("Japan 2026");
    expect(body.version).toBe(1);
    expect(body.status).toBe("active");
    expect(response.headers?.etag).toBe('"1"');
  });

  it("POST rejects invalid body and endDate before startDate", async () => {
    const badJson = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: "{",
        }),
        deps(),
      ),
    );
    expect(badJson.status).toBe(400);

    const badRange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: JSON.stringify({
            title: "X",
            timezone: "UTC",
            startDate: "2026-06-10",
            endDate: "2026-06-01",
          }),
        }),
        deps(),
      ),
    );
    expect(badRange.status).toBe(400);
    const body = JSON.parse(badRange.body ?? "{}") as { type: string };
    expect(body.type).toBe("ValidationError");
  });

  it("POST enforces max 100 active trips per owner", async () => {
    const tripRepo = makeInMemoryTripRepo();
    for (let i = 0; i < MAX_ACTIVE_TRIPS_PER_OWNER; i += 1) {
      const res = await Effect.runPromise(
        handleRequest(
          baseRequest({
            method: "POST",
            path: "/api/v1/trips",
            body: JSON.stringify({
              title: `T${i}`,
              timezone: "UTC",
              startDate: "2026-01-01",
              endDate: "2026-01-02",
            }),
          }),
          deps(tripRepo),
        ),
      );
      expect(res.status).toBe(201);
    }
    const over = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    expect(over.status).toBe(400);
    const body = JSON.parse(over.body ?? "{}") as {
      type: string;
      message: string;
    };
    expect(body.type).toBe("ValidationError");
    expect(body.message).toMatch(/limit/i);
  });

  it("soft-delete frees a quota slot for another create", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_TRIPS_PER_OWNER; i += 1) {
      const res = await Effect.runPromise(
        handleRequest(
          baseRequest({
            method: "POST",
            path: "/api/v1/trips",
            body: JSON.stringify({
              title: `Q${i}`,
              timezone: "UTC",
              startDate: "2026-01-01",
              endDate: "2026-01-02",
            }),
          }),
          deps(tripRepo),
        ),
      );
      expect(res.status).toBe(201);
      ids.push(
        (JSON.parse(res.body ?? "{}") as { tripId: string }).tripId,
      );
    }
    const blocked = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    expect(blocked.status).toBe(400);

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${ids[0]}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(del.status).toBe(200);

    const again = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    expect(again.status).toBe(201);
  });

  it("GET /api/v1/trips lists only the caller's active trips with cursor", async () => {
    const tripRepo = makeInMemoryTripRepo();
    for (let i = 0; i < 3; i += 1) {
      await Effect.runPromise(
        handleRequest(
          baseRequest({
            method: "POST",
            path: "/api/v1/trips",
            body: JSON.stringify({
              title: `Trip ${i}`,
              timezone: "UTC",
              startDate: "2026-01-01",
              endDate: "2026-01-05",
            }),
          }),
          deps(tripRepo),
        ),
      );
    }
    // Other owner's trip must not appear.
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo, other),
      ),
    );

    const page1 = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/trips",
          query: { limit: "2" },
        }),
        deps(tripRepo),
      ),
    );
    expect(page1.status).toBe(200);
    const list1 = JSON.parse(page1.body ?? "{}") as {
      trips: { ownerId: string; title: string }[];
      nextCursor?: string;
    };
    expect(list1.trips).toHaveLength(2);
    expect(list1.trips.every((t) => t.ownerId === "owner-1")).toBe(true);
    expect(list1.nextCursor).toBeDefined();

    const page2 = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/trips",
          query: { limit: "2", cursor: list1.nextCursor },
        }),
        deps(tripRepo),
      ),
    );
    const list2 = JSON.parse(page2.body ?? "{}") as {
      trips: unknown[];
      nextCursor?: string;
    };
    expect(list2.trips).toHaveLength(1);
    expect(list2.nextCursor).toBeUndefined();
  });

  it("GET /api/v1/trips/:tripId returns meta + empty items; 404 for other owner", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as { tripId: string };

    const got = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(got.status).toBe(200);
    const detail = JSON.parse(got.body ?? "{}") as {
      tripId: string;
      items: unknown[];
    };
    expect(detail.tripId).toBe(trip.tripId);
    expect(detail.items).toEqual([]);

    const foreign = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo, other),
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("GET export returns downloadable payload", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as { tripId: string };
    const exp = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${trip.tripId}/export`,
        }),
        deps(tripRepo),
      ),
    );
    expect(exp.status).toBe(200);
    expect(exp.headers?.["content-disposition"]).toMatch(/attachment/);
    const body = JSON.parse(exp.body ?? "{}") as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("PATCH requires If-Match and rejects expectedVersion in body", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as {
      tripId: string;
      version: number;
    };

    const noMatch = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${trip.tripId}`,
          body: JSON.stringify({ title: "New" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(noMatch.status).toBe(400);

    const withExpected = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${trip.tripId}`,
          headers: { "if-match": `"${trip.version}"` },
          body: JSON.stringify({ title: "New", expectedVersion: 1 }),
        }),
        deps(tripRepo),
      ),
    );
    expect(withExpected.status).toBe(400);
    const err = JSON.parse(withExpected.body ?? "{}") as { message: string };
    expect(err.message).toMatch(/expectedVersion/);

    const ok = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${trip.tripId}`,
          headers: { "if-match": `"${trip.version}"` },
          body: JSON.stringify({ title: "Updated title" }),
        }),
        deps(tripRepo),
      ),
    );
    expect(ok.status).toBe(200);
    const updated = JSON.parse(ok.body ?? "{}") as {
      title: string;
      version: number;
    };
    expect(updated.title).toBe("Updated title");
    expect(updated.version).toBe(2);
    expect(ok.headers?.etag).toBe('"2"');

    const conflict = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${trip.tripId}`,
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

  it("DELETE soft-deletes; list and GET hide; second delete 404", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as { tripId: string };

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(del.status).toBe(200);
    const delBody = JSON.parse(del.body ?? "{}") as {
      status: string;
      deletedAt: string;
    };
    expect(delBody.status).toBe("deleted");
    expect(delBody.deletedAt).toBeDefined();

    const get = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(get.status).toBe(404);

    const list = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: "/api/v1/trips" }),
        deps(tripRepo),
      ),
    );
    const listBody = JSON.parse(list.body ?? "{}") as { trips: unknown[] };
    expect(listBody.trips).toHaveLength(0);

    const again = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(again.status).toBe(404);
  });

  it("DELETE returns 403 when tripsDeleteEnabled is false", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as { tripId: string };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        {
          ...deps(tripRepo),
          routes: buildRoutes({ tripsDeleteEnabled: false }),
        },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("requires owner auth on trip routes", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: "/api/v1/trips" }),
        deps(makeInMemoryTripRepo(), null),
      ),
    );
    expect(response.status).toBe(401);
  });

  it("foreign owner PATCH/DELETE return 404 (owner-key isolation)", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/trips",
          body: createBody,
        }),
        deps(tripRepo),
      ),
    );
    const trip = JSON.parse(created.body ?? "{}") as {
      tripId: string;
      version: number;
    };

    const patchForeign = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "PATCH",
          path: `/api/v1/trips/${trip.tripId}`,
          headers: { "if-match": `"${trip.version}"` },
          body: JSON.stringify({ title: "Hijack" }),
        }),
        deps(tripRepo, other),
      ),
    );
    expect(patchForeign.status).toBe(404);

    const deleteForeign = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo, other),
      ),
    );
    expect(deleteForeign.status).toBe(404);

    // Original owner can still read.
    const stillThere = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${trip.tripId}`,
        }),
        deps(tripRepo),
      ),
    );
    expect(stillThere.status).toBe(200);
  });
});
