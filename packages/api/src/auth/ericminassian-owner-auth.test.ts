import type {
  AccessTokenClaims,
  AuthResult,
  AuthVerifier,
} from "@ericminassian/auth/server";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../http/types.js";
import { silentLogger } from "../logging/logger.js";
import {
  authFailureMessage,
  makeEricminassianOwnerAuth,
  toFetchRequest,
  toOwnerPrincipal,
} from "./ericminassian-owner-auth.js";

const baseClaims: AccessTokenClaims = {
  sub: "user-42",
  sid: "sess-1",
  scope: "openid profile offline_access",
  client_id: "plan",
  iat: 1_700_000_000,
  exp: 1_700_003_600,
  jti: "jti-1",
};

function request(partial: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: partial.method ?? "GET",
    path: partial.path ?? "/api/v1/me",
    url: partial.url ?? "https://plan.ericminassian.com/api/v1/me",
    headers: partial.headers ?? {
      authorization: "Bearer test-token",
      dpop: "proof.jwt.here",
    },
    query: partial.query ?? {},
    cookies: partial.cookies ?? {},
    body: partial.body,
    requestId: partial.requestId ?? "req-auth-1",
    clientIp: partial.clientIp ?? "127.0.0.1",
  };
}

function mockVerifier(
  result: AuthResult | (() => Promise<AuthResult>),
): AuthVerifier {
  return {
    authenticateRequest: vi.fn(async () =>
      typeof result === "function" ? result() : result,
    ),
    verifyAccessToken: vi.fn(),
    verifyLogoutToken: vi.fn(),
  };
}

describe("makeEricminassianOwnerAuth", () => {
  const config = {
    authIssuer: "https://auth.ericminassian.com",
    authAudience: "plan",
  };

  it("maps authenticated claims to OwnerPrincipal (nickname + iss fallback)", async () => {
    const claims = {
      ...baseClaims,
      nickname: "Ada",
    } as AccessTokenClaims & { nickname: string };
    const verifier = mockVerifier({
      authenticated: true,
      claims,
    });
    const req = request();
    const auth = makeEricminassianOwnerAuth(config, () => req, verifier);

    const principal = await Effect.runPromise(auth.requireOwner());
    expect(principal.sub).toBe("user-42");
    expect(principal.nickname).toBe("Ada");
    expect(principal.iss).toBe("https://auth.ericminassian.com");
    expect(verifier.authenticateRequest).toHaveBeenCalledOnce();
  });

  it("uses iss claim when present", async () => {
    const claims = {
      ...baseClaims,
      iss: "https://custom.issuer.example",
    } as AccessTokenClaims & { iss: string };
    const verifier = mockVerifier({ authenticated: true, claims });
    const auth = makeEricminassianOwnerAuth(
      config,
      () => request(),
      verifier,
    );
    const principal = await Effect.runPromise(auth.requireOwner());
    expect(principal.iss).toBe("https://custom.issuer.example");
  });

  it("returns 401 Unauthorized with www-authenticate on missing token", async () => {
    const www = 'Bearer realm="plan", error="invalid_token"';
    const verifier = mockVerifier({
      authenticated: false,
      reason: "missing",
      wwwAuthenticate: www,
    });
    const auth = makeEricminassianOwnerAuth(
      config,
      () => request({ headers: {} }),
      verifier,
    );
    const result = await Effect.runPromise(Effect.either(auth.requireOwner()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("Unauthorized");
      expect(result.left.message).toBe("Missing access token");
      expect(result.left.wwwAuthenticate).toBe(www);
    }
  });

  it("returns 401 for invalid token", async () => {
    const verifier = mockVerifier({
      authenticated: false,
      reason: "invalid",
      wwwAuthenticate: "Bearer error=\"invalid_token\"",
    });
    const auth = makeEricminassianOwnerAuth(
      config,
      () => request(),
      verifier,
    );
    const result = await Effect.runPromise(Effect.either(auth.requireOwner()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("Unauthorized");
      expect(result.left.message).toBe("Invalid access token");
    }
  });

  it("maps unexpected verifier throws to InternalError (not 401) without leaking cause", async () => {
    const verifier = mockVerifier(async () => {
      throw new Error("jwks network boom");
    });
    const logs: Array<{ message: string; cause?: string | number | boolean }> =
      [];
    const logger = {
      log: (
        _level: "debug" | "info" | "warn" | "error",
        message: string,
        fields: Readonly<
          Record<string, string | number | boolean | undefined>
        > = {},
      ) => {
        logs.push({ message, cause: fields.cause });
      },
      request: () => {},
    };
    const auth = makeEricminassianOwnerAuth(
      config,
      () => request(),
      verifier,
      logger,
    );
    const result = await Effect.runPromise(Effect.either(auth.requireOwner()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("InternalError");
      expect(result.left.message).toBe("Internal server error");
      expect(result.left.message).not.toMatch(/jwks/i);
    }
    expect(logs.some((l) => l.cause === "jwks network boom")).toBe(true);
  });

  it("maps missing active request to InternalError without leaking cause", async () => {
    const verifier = mockVerifier({
      authenticated: true,
      claims: baseClaims,
    });
    const auth = makeEricminassianOwnerAuth(
      config,
      () => {
        throw new Error("OwnerAuth invoked without an active request");
      },
      verifier,
      silentLogger,
    );
    const result = await Effect.runPromise(Effect.either(auth.requireOwner()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.type).toBe("InternalError");
      expect(result.left.message).toBe("Internal server error");
    }
  });

  it("passes method, absolute URL, Authorization, and DPoP to verifier", async () => {
    const verifier = mockVerifier({
      authenticated: true,
      claims: baseClaims,
    });
    const req = request({
      method: "GET",
      url: "https://plan.ericminassian.com/api/v1/me",
      headers: {
        authorization: "Bearer abc",
        dpop: "dpop-proof",
      },
    });
    const auth = makeEricminassianOwnerAuth(config, () => req, verifier);
    await Effect.runPromise(auth.requireOwner());

    const call = vi.mocked(verifier.authenticateRequest).mock.calls[0]?.[0];
    expect(call).toBeInstanceOf(Request);
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe("https://plan.ericminassian.com/api/v1/me");
    expect(call?.headers.get("authorization")).toBe("Bearer abc");
    expect(call?.headers.get("dpop")).toBe("dpop-proof");
  });
});

describe("toFetchRequest", () => {
  it("preserves Authorization and DPoP headers", () => {
    const fetchReq = toFetchRequest(
      request({
        headers: {
          authorization: "Bearer xyz",
          dpop: "proof",
          "content-type": "application/json",
        },
      }),
    );
    expect(fetchReq.headers.get("authorization")).toBe("Bearer xyz");
    expect(fetchReq.headers.get("dpop")).toBe("proof");
    expect(fetchReq.url).toBe("https://plan.ericminassian.com/api/v1/me");
  });

  it("reconstructs cookie header from cookies map", () => {
    const fetchReq = toFetchRequest(
      request({
        headers: {},
        cookies: { tripplan_share: "sess" },
      }),
    );
    expect(fetchReq.headers.get("cookie")).toBe("tripplan_share=sess");
  });
});

describe("toOwnerPrincipal / authFailureMessage", () => {
  it("falls back display fields correctly", () => {
    const principal = toOwnerPrincipal(baseClaims, "https://auth.example");
    expect(principal.nickname).toBeUndefined();
    expect(principal.iss).toBe("https://auth.example");
  });

  it("maps failure reasons", () => {
    expect(authFailureMessage("missing")).toBe("Missing access token");
    expect(authFailureMessage("invalid")).toBe("Invalid access token");
    expect(authFailureMessage("expired")).toBe("Access token expired");
  });
});
