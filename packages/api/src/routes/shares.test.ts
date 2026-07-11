import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "../auth/mock-owner-auth.js";
import { SHARE_COOKIE_NAME } from "../auth/share-auth.js";
import type { HttpRequest } from "../http/types.js";
import { makeShareSessionRateLimiter } from "../http/rate-limit.js";
import { silentLogger } from "../logging/logger.js";
import { makeInMemoryShareRepo } from "../repos/share-repo.js";
import { makeInMemoryTripRepo } from "../repos/trip-repo.js";
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
    clientIp: partial.clientIp ?? "203.0.113.10",
  };
}

const owner = mockPrincipal({ sub: "owner-1", nickname: "Ada" });

function deps(options: {
  readonly tripRepo?: ReturnType<typeof makeInMemoryTripRepo>;
  readonly shareRepo?: ReturnType<typeof makeInMemoryShareRepo>;
  readonly userRepo?: ReturnType<typeof makeInMemoryUserRepo>;
  readonly principal?: ReturnType<typeof mockPrincipal> | null;
  readonly routes?: ReturnType<typeof buildRoutes>;
} = {}) {
  const tripRepo = options.tripRepo ?? makeInMemoryTripRepo();
  const shareRepo = options.shareRepo ?? makeInMemoryShareRepo();
  return {
    ownerAuth: makeMockOwnerAuth(
      options.principal === undefined ? owner : options.principal,
    ),
    userRepo: options.userRepo ?? makeInMemoryUserRepo(),
    tripRepo,
    shareRepo,
    logger: silentLogger,
    routes: options.routes,
  };
}

const createTripBody = JSON.stringify({
  title: "Japan 2026",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
});

async function createTrip(
  tripRepo: ReturnType<typeof makeInMemoryTripRepo>,
): Promise<string> {
  const response = await Effect.runPromise(
    handleRequest(
      baseRequest({
        method: "POST",
        path: "/api/v1/trips",
        body: createTripBody,
      }),
      deps({ tripRepo }),
    ),
  );
  expect(response.status).toBe(201);
  const body = JSON.parse(response.body ?? "{}") as { tripId: string };
  return body.tripId;
}

function parseCookieSessionId(setCookie: string | undefined): string {
  expect(setCookie).toBeDefined();
  const cookie = setCookie ?? "";
  expect(cookie).toContain(`${SHARE_COOKIE_NAME}=`);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
  expect(cookie).toMatch(/Path=\//i);
  const part = cookie.split(";")[0] ?? "";
  const eq = part.indexOf("=");
  return part.slice(eq + 1);
}

describe("share grants + session", () => {
  it("creates a share grant and returns raw token once", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);

    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: JSON.stringify({ label: "Family" }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(response.status).toBe(201);
    const body = JSON.parse(response.body ?? "{}") as {
      shareId: string;
      token: string;
      path: string;
      expiresAt: string;
      label: string;
    };
    expect(body.shareId).toMatch(/^shr_/);
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.path).toBe("/s");
    expect(body.label).toBe("Family");
    expect(body.expiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    );

    const listed = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: `/api/v1/trips/${tripId}/shares`,
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(listed.status).toBe(200);
    const listBody = JSON.parse(listed.body ?? "{}") as {
      shares: Array<{ shareId: string; token?: string; label: string }>;
    };
    expect(listBody.shares).toHaveLength(1);
    expect(listBody.shares[0]?.shareId).toBe(body.shareId);
    expect(listBody.shares[0]?.label).toBe("Family");
    expect(listBody.shares[0]?.token).toBeUndefined();
  });

  it("rejects expiresAt in the past or beyond 365 days", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);

    const past = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: JSON.stringify({ expiresAt: "2020-01-01T00:00:00Z" }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(past.status).toBe(400);

    const far = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: JSON.stringify({
            expiresAt: "2099-01-01T00:00:00Z",
          }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(far.status).toBe(400);
  });

  it("exchanges token for session cookie and returns ShareTripDTO", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const userRepo = makeInMemoryUserRepo();
    // Seed profile so share DTO has display name.
    await Effect.runPromise(
      userRepo.upsertFromPrincipal(owner),
    );
    const tripId = await createTrip(tripRepo);

    // Add a note item for the viewer timeline.
    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/items`,
          body: JSON.stringify({
            type: "note",
            title: "Pack socks",
            notes: "Merino",
            details: {},
          }),
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: JSON.stringify({ label: "Friends" }),
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    const createBody = JSON.parse(created.body ?? "{}") as { token: string };

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: createBody.token }),
          headers: { origin: "https://plan.ericminassian.com" },
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    expect(exchange.status).toBe(204);
    const sessionId = parseCookieSessionId(exchange.cookies?.[0]);

    const trip = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    expect(trip.status).toBe(200);
    const dto = JSON.parse(trip.body ?? "{}") as {
      tripId: string;
      title: string;
      ownerDisplayName: string;
      ownerId?: string;
      items: Array<{ title: string; type: string }>;
    };
    expect(dto.tripId).toBe(tripId);
    expect(dto.title).toBe("Japan 2026");
    expect(dto.ownerDisplayName).toBe("Ada");
    expect(dto.ownerId).toBeUndefined();
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]?.title).toBe("Pack socks");
  });

  it("returns 410 on GET /share/trip when trip is soft-deleted after exchange", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: "{}",
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const { token } = JSON.parse(created.body ?? "{}") as { token: string };

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(exchange.status).toBe(204);
    const sessionId = parseCookieSessionId(exchange.cookies?.[0]);

    const del = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}`,
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(del.status).toBe(200);

    const trip = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(trip.status).toBe(410);
    const body = JSON.parse(trip.body ?? "{}") as { type: string };
    expect(body.type).toBe("Gone");
  });

  it("returns 401 (not 410) when exchanging token after trip soft-delete", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: "{}",
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const { token } = JSON.parse(created.body ?? "{}") as { token: string };

    await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}`,
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(exchange.status).toBe(401);
    const body = JSON.parse(exchange.body ?? "{}") as { type: string };
    expect(body.type).toBe("Unauthorized");
  });

  it("never puts ownerId/sub in ownerDisplayName when profile is missing", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    // Empty user repo — profile miss is the cold-start reality.
    const userRepo = makeInMemoryUserRepo();
    const tripId = await createTrip(tripRepo);

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: "{}",
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    const { token } = JSON.parse(created.body ?? "{}") as { token: string };

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token }),
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    const sessionId = parseCookieSessionId(exchange.cookies?.[0]);

    const trip = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo, userRepo }),
      ),
    );
    expect(trip.status).toBe(200);
    const dto = JSON.parse(trip.body ?? "{}") as {
      ownerDisplayName: string;
      ownerId?: string;
    };
    expect(dto.ownerId).toBeUndefined();
    expect(dto.ownerDisplayName).toBe("Trip owner");
    expect(dto.ownerDisplayName).not.toBe(owner.sub);
    expect(dto.ownerDisplayName).not.toContain(owner.sub);
  });

  it("rejects disallowed Origin with 403 when allowlist is configured", async () => {
    const routes = buildRoutes({
      tripsDeleteEnabled: true,
      shareAllowedOrigins: ["https://plan.ericminassian.com"],
    });
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: "abc" }),
          headers: { origin: "https://evil.example" },
        }),
        deps({ routes }),
      ),
    );
    expect(response.status).toBe(403);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("Forbidden");
  });

  it("rejects oversized exchange tokens with 400", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: "x".repeat(200) }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 after revoke (sessions deleted)", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);

    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: "{}",
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const createBody = JSON.parse(created.body ?? "{}") as {
      token: string;
      shareId: string;
    };

    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: createBody.token }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const sessionId = parseCookieSessionId(exchange.cookies?.[0]);

    const revoke = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: `/api/v1/trips/${tripId}/shares/${createBody.shareId}`,
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(revoke.status).toBe(204);

    const trip = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(trip.status).toBe(401);
  });

  it("rejects invalid token exchange with 401", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: "not-a-real-token" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(401);
  });

  it("rate-limits share session attempts per IP", async () => {
    const rateLimiter = makeShareSessionRateLimiter();
    // Fill the window.
    for (let i = 0; i < 20; i += 1) {
      rateLimiter.check("10.0.0.1");
    }
    expect(() => rateLimiter.check("10.0.0.1")).toThrow();

    const routes = buildRoutes(
      { tripsDeleteEnabled: true, shareAllowedOrigins: [] },
      rateLimiter,
    );
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token: "x" }),
          clientIp: "10.0.0.1",
        }),
        deps({ routes }),
      ),
    );
    expect(response.status).toBe(429);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("RateLimited");
  });

  it("DELETE /share/session clears cookie", async () => {
    const tripRepo = makeInMemoryTripRepo();
    const shareRepo = makeInMemoryShareRepo();
    const tripId = await createTrip(tripRepo);
    const created = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: `/api/v1/trips/${tripId}/shares`,
          body: "{}",
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const { token } = JSON.parse(created.body ?? "{}") as { token: string };
    const exchange = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/share/session",
          body: JSON.stringify({ token }),
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    const sessionId = parseCookieSessionId(exchange.cookies?.[0]);

    const cleared = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "DELETE",
          path: "/api/v1/share/session",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(cleared.status).toBe(204);
    expect(cleared.cookies?.[0]).toMatch(/Max-Age=0/);

    const after = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "GET",
          path: "/api/v1/share/trip",
          cookies: { [SHARE_COOKIE_NAME]: sessionId },
        }),
        deps({ tripRepo, shareRepo }),
      ),
    );
    expect(after.status).toBe(401);
  });
});
