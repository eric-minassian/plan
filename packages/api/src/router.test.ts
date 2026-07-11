import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "./auth/mock-owner-auth.js";
import {
  makeShareAuthStub,
  SHARE_COOKIE_NAME,
} from "./auth/share-auth.js";
import { silentLogger } from "./logging/logger.js";
import { makeInMemoryTripRepo } from "./repos/trip-repo.js";
import { makeInMemoryUserRepo } from "./repos/user-repo.js";
import { handleRequest, routes } from "./router.js";
import type { HttpRequest } from "./http/types.js";

function baseRequest(partial: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">): HttpRequest {
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

function emptyRepos() {
  return {
    userRepo: makeInMemoryUserRepo(),
    tripRepo: makeInMemoryTripRepo(),
    logger: silentLogger,
  };
}

describe("authz matrix", () => {
  it("exposes health as public and me/trips as owner", () => {
    const health = routes.find((r) => r.path === "/api/v1/health");
    const meGet = routes.find(
      (r) => r.method === "GET" && r.path === "/api/v1/me",
    );
    const meDelete = routes.find(
      (r) => r.method === "DELETE" && r.path === "/api/v1/me",
    );
    const listTrips = routes.find(
      (r) => r.method === "GET" && r.path === "/api/v1/trips",
    );
    expect(health?.authClass).toBe("public");
    expect(meGet?.authClass).toBe("owner");
    expect(meDelete?.authClass).toBe("owner");
    expect(listTrips?.authClass).toBe("owner");
  });

  it("GET /api/v1/health succeeds without owner auth", async () => {
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/health" }), {
        ownerAuth: makeMockOwnerAuth(null),
        ...emptyRepos(),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body ?? "{}")).toEqual({ status: "ok" });
  });

  it("GET /api/v1/me returns 401 without principal", async () => {
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(null),
        ...emptyRepos(),
      }),
    );
    expect(response.status).toBe(401);
    const body = JSON.parse(response.body ?? "{}") as { type: string; requestId: string };
    expect(body.type).toBe("Unauthorized");
    expect(body.requestId).toBe("test-request-id");
  });

  it("GET /api/v1/me upserts profile from mock principal", async () => {
    const principal = mockPrincipal({
      sub: "user-123",
      nickname: "Ada",
      iss: "https://auth.ericminassian.com",
    });
    const userRepo = makeInMemoryUserRepo();

    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(principal),
        userRepo,
        tripRepo: makeInMemoryTripRepo(),
        logger: silentLogger,
      }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "{}") as {
      userId: string;
      displayName: string;
      iss: string;
      createdAt: string;
    };
    expect(body.userId).toBe("user-123");
    expect(body.displayName).toBe("Ada");
    expect(body.iss).toBe("https://auth.ericminassian.com");
    expect(body.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    );

    // Second call preserves createdAt and keeps displayName.
    const again = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(principal),
        userRepo,
        tripRepo: makeInMemoryTripRepo(),
        logger: silentLogger,
      }),
    );
    const body2 = JSON.parse(again.body ?? "{}") as { createdAt: string };
    expect(body2.createdAt).toBe(body.createdAt);
  });

  it("DELETE /api/v1/me returns 202 not_implemented stub (data not purged)", async () => {
    const principal = mockPrincipal({ sub: "purge-user" });
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "DELETE", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(principal),
        ...emptyRepos(),
      }),
    );
    expect(response.status).toBe(202);
    const body = JSON.parse(response.body ?? "{}") as {
      status: string;
      userId: string;
      message: string;
    };
    expect(body.status).toBe("not_implemented");
    expect(body.userId).toBe("purge-user");
    expect(body.message).toMatch(/not fully implemented/i);
  });

  it("GET /api/v1/me uses sub as displayName when nickname absent", async () => {
    const principal = mockPrincipal({ sub: "user-no-nick" });
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(principal),
        ...emptyRepos(),
      }),
    );
    const body = JSON.parse(response.body ?? "{}") as { displayName: string };
    expect(body.displayName).toBe("user-no-nick");
  });

  it("unknown route returns 404 ApiErrorBody", async () => {
    const response = await Effect.runPromise(
      handleRequest(
        baseRequest({ method: "GET", path: "/api/v1/not-a-real-route" }),
        {
          ownerAuth: makeMockOwnerAuth(null),
          ...emptyRepos(),
        },
      ),
    );
    expect(response.status).toBe(404);
    const body = JSON.parse(response.body ?? "{}") as { type: string };
    expect(body.type).toBe("NotFound");
  });

  it("share auth stub rejects missing cookie", async () => {
    const share = makeShareAuthStub(() => undefined);
    const result = await Effect.runPromise(
      Effect.either(share.requireShare()),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("Unauthorized");
    }
  });

  it("share auth stub rejects cookie without revalidation store", async () => {
    const share = makeShareAuthStub(() => "session-abc");
    const result = await Effect.runPromise(
      Effect.either(share.requireShare()),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("Unauthorized");
    }
  });

  it("share cookie name is tripplan_share", () => {
    expect(SHARE_COOKIE_NAME).toBe("tripplan_share");
  });

  it("registers share session and share trip routes", () => {
    const session = routes.find(
      (r) => r.method === "POST" && r.path === "/api/v1/share/session",
    );
    const trip = routes.find(
      (r) => r.method === "GET" && r.path === "/api/v1/share/trip",
    );
    const del = routes.find(
      (r) => r.method === "DELETE" && r.path === "/api/v1/share/session",
    );
    expect(session?.authClass).toBe("public");
    expect(trip?.authClass).toBe("share");
    expect(del?.authClass).toBe("share");
  });

  it("wrong method on known path returns 405 with Allow", async () => {
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "POST", path: "/api/v1/me" }), {
        ownerAuth: makeMockOwnerAuth(null),
        ...emptyRepos(),
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers?.allow).toBe("GET, DELETE");
    const body = JSON.parse(response.body ?? "{}") as {
      type: string;
      retryable: boolean;
      message: string;
    };
    expect(body.type).toBe("MethodNotAllowed");
    expect(body.retryable).toBe(false);
    expect(body.message).toBe("Method not allowed");
  });

  it("requireOwner is invoked once for owner routes", async () => {
    let calls = 0;
    const principal = mockPrincipal({ sub: "once" });
    const response = await Effect.runPromise(
      handleRequest(baseRequest({ method: "GET", path: "/api/v1/me" }), {
        ownerAuth: {
          requireOwner: () => {
            calls += 1;
            return Effect.succeed(principal);
          },
        },
        ...emptyRepos(),
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });
});
