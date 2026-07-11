import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "../auth/mock-owner-auth.js";
import { makeInMemoryEnrichBudget } from "../enrichment/budget.js";
import { makeMockFlightProvider } from "../enrichment/mock-flight-provider.js";
import { makeInMemoryEnrichRateLimiter } from "../enrichment/rate-limit.js";
import { AppError } from "../errors/app-error.js";
import type { HttpRequest } from "../http/types.js";
import { silentLogger } from "../logging/logger.js";
import { makeInMemoryTripRepo } from "../repos/trip-repo.js";
import { makeInMemoryUserRepo } from "../repos/user-repo.js";
import { buildRoutes, handleRequest } from "../router.js";
import { normalizeInstant } from "@tripplan/domain";

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

function deps(
  principal: ReturnType<typeof mockPrincipal> | null = owner,
  extras: {
    rateLimit?: number;
    budgetUsd?: number;
    liveCost?: number;
  } = {},
) {
  return {
    ownerAuth: makeMockOwnerAuth(principal),
    userRepo: makeInMemoryUserRepo(),
    tripRepo: makeInMemoryTripRepo(),
    logger: silentLogger,
    flightProvider: makeMockFlightProvider(() =>
      normalizeInstant("2026-07-11T12:00:00Z"),
    ),
    enrichmentGuards: {
      rateLimiter: makeInMemoryEnrichRateLimiter(extras.rateLimit ?? 60),
      budget: makeInMemoryEnrichBudget(extras.budgetUsd ?? 25),
      liveLookupCostUsd: extras.liveCost ?? 0.01,
      livePlaceLookupCostUsd: extras.liveCost ?? 0.005,
    },
  };
}

describe("POST /api/v1/enrich/flight", () => {
  it("registers owner auth class", () => {
    const route = buildRoutes().find(
      (r) => r.method === "POST" && r.path === "/api/v1/enrich/flight",
    );
    expect(route?.authClass).toBe("owner");
  });

  it("returns 401 without owner JWT", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        deps(null),
      ),
    );
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("Unauthorized");
  });

  it("returns 200 found for mock UA100", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "{}") as {
      status: string;
      provider: string;
      departure: { airportIata: string };
    };
    expect(body.status).toBe("found");
    expect(body.provider).toBe("mock");
    expect(body.departure.airportIata).toBe("SFO");
  });

  it("returns 200 not_found DTO (not ApiErrorBody) for unknown flight", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "XX999", date: "2026-07-15" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "{}") as {
      status: string;
      type?: string;
      provider: string;
    };
    expect(body.status).toBe("not_found");
    expect(body.type).toBeUndefined();
    expect(body.provider).toBe("mock");
  });

  it("returns 400 on invalid body", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("returns 422 AmbiguousEnrichment for AMB1", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "AMB1", date: "2026-07-15" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("AmbiguousEnrichment");
  });

  it("returns 429 when rate limit exceeded", async () => {
    const limited = deps(owner, { rateLimit: 1 });
    const first = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        limited,
      ),
    );
    expect(first.status).toBe(200);

    const second = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        limited,
      ),
    );
    expect(second.status).toBe(429);
    const body = JSON.parse(second.body ?? "{}") as { type: string };
    expect(body.type).toBe("RateLimited");
  });

  it("returns 502 UpstreamUnavailable when live budget is exceeded", async () => {
    const budget = makeInMemoryEnrichBudget(0.01, 0.01);
    const liveProvider = {
      name: "aerodatabox",
      isLive: true as const,
      lookup: () =>
        Effect.succeed({
          status: "not_found" as const,
          provider: "aerodatabox",
          fetchedAt: normalizeInstant("2026-07-11T12:00:00Z"),
        }),
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          flightProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("UpstreamUnavailable");
    // Must not call provider / burn more when ensureAvailable fails.
    expect(budget.spentUsd()).toBe(0.01);
  });

  it("does not charge budget for mock lookups", async () => {
    const budget = makeInMemoryEnrichBudget(25);
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          flightProvider: makeMockFlightProvider(() =>
            normalizeInstant("2026-07-11T12:00:00Z"),
          ),
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(budget.spentUsd()).toBe(0);
  });

  it("charges live budget after a successful billable lookup", async () => {
    const budget = makeInMemoryEnrichBudget(25);
    const liveProvider = {
      name: "aerodatabox",
      isLive: true as const,
      lookup: () =>
        Effect.succeed({
          status: "not_found" as const,
          provider: "aerodatabox",
          fetchedAt: normalizeInstant("2026-07-11T12:00:00Z"),
        }),
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          flightProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(budget.spentUsd()).toBe(0.01);
  });

  it("does not charge live budget when credentials are missing", async () => {
    const budget = makeInMemoryEnrichBudget(25);
    const liveProvider = {
      name: "aerodatabox",
      isLive: true as const,
      lookup: () =>
        Effect.fail(
          AppError.upstreamUnavailable(
            "AeroDataBox credentials not configured (set AERODATABOX_API_KEY)",
          ),
        ),
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/flight",
          body: JSON.stringify({ flightNumber: "UA100", date: "2026-07-15" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          flightProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    expect(budget.spentUsd()).toBe(0);
  });
});

describe("POST /api/v1/enrich/place", () => {
  it("registers owner auth class", () => {
    const route = buildRoutes().find(
      (r) => r.method === "POST" && r.path === "/api/v1/enrich/place",
    );
    expect(route?.authClass).toBe("owner");
  });

  it("returns 401 without owner JWT", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Louvre" }),
        }),
        deps(null),
      ),
    );
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("Unauthorized");
  });

  it("returns 200 found for mock louvre", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Louvre" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "{}") as {
      status: string;
      provider: string;
      results: Array<{ label: string; lat: number; lng: number }>;
    };
    expect(body.status).toBe("found");
    expect(body.provider).toBe("mock");
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0]?.label).toContain("Louvre");
  });

  it("returns 200 not_found for mock notfound fixture", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "notfound" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "{}") as {
      status: string;
      results: unknown[];
    };
    expect(body.status).toBe("not_found");
    expect(body.results).toEqual([]);
  });

  it("returns 400 for empty query", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "" }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("rate limits place enrich same as flight (distinct queries)", async () => {
    // Same query is short-TTL cached and does not re-take the rate limit.
    const limited = deps(owner, { rateLimit: 1 });
    const first = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Paris-unique-a" }),
        }),
        limited,
      ),
    );
    expect(first.status).toBe(200);
    const second = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Paris-unique-b" }),
        }),
        limited,
      ),
    );
    expect(second.status).toBe(429);
  });

  it("serves identical place queries from cache without a second rate token", async () => {
    const limited = deps(owner, { rateLimit: 1 });
    const first = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Louvre-cache-hit" }),
        }),
        limited,
      ),
    );
    expect(first.status).toBe(200);
    const second = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "Louvre-cache-hit" }),
        }),
        limited,
      ),
    );
    expect(second.status).toBe(200);
  });

  it("rejects whitespace-only place query with 400", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "   " }),
        }),
        deps(),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("charges live place budget after a successful billable lookup", async () => {
    const budget = makeInMemoryEnrichBudget(25);
    const liveProvider = {
      name: "maptiler",
      isLive: true as const,
      search: () =>
        Effect.succeed({
          status: "not_found" as const,
          results: [] as const,
          provider: "maptiler",
          fetchedAt: normalizeInstant("2026-07-11T12:00:00Z"),
        }),
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "live-budget-ok" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          placeProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(budget.spentUsd()).toBe(0.005);
  });

  it("does not charge live place budget when credentials are missing", async () => {
    const budget = makeInMemoryEnrichBudget(25);
    const liveProvider = {
      name: "maptiler",
      isLive: true as const,
      search: () =>
        Effect.fail(
          AppError.upstreamUnavailable(
            "MapTiler credentials not configured (set MAPTILER_API_KEY)",
          ),
        ),
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "live-budget-missing-creds" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          placeProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    expect(budget.spentUsd()).toBe(0);
  });

  it("returns 502 without calling spend when place budget is exhausted", async () => {
    const budget = makeInMemoryEnrichBudget(0.004, 0.004);
    let called = false;
    const liveProvider = {
      name: "maptiler",
      isLive: true as const,
      search: () => {
        called = true;
        return Effect.succeed({
          status: "not_found" as const,
          results: [] as const,
          provider: "maptiler",
          fetchedAt: normalizeInstant("2026-07-11T12:00:00Z"),
        });
      },
    };
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({
          method: "POST",
          path: "/api/v1/enrich/place",
          body: JSON.stringify({ query: "live-budget-exhausted" }),
        }),
        {
          ownerAuth: makeMockOwnerAuth(owner),
          userRepo: makeInMemoryUserRepo(),
          tripRepo: makeInMemoryTripRepo(),
          logger: silentLogger,
          placeProvider: liveProvider,
          enrichmentGuards: {
            rateLimiter: makeInMemoryEnrichRateLimiter(60),
            budget,
            liveLookupCostUsd: 0.01,
            livePlaceLookupCostUsd: 0.005,
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    expect(called).toBe(false);
    expect(budget.spentUsd()).toBe(0.004);
  });
});
