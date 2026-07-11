import {
  createAuthVerifier,
  type AccessTokenClaims,
  type AuthVerifier,
} from "@ericminassian/auth/server";
import { Effect } from "effect";
import type { ApiConfig } from "../config.js";
import { AppError, internalFromCause } from "../errors/app-error.js";
import type { HttpRequest } from "../http/types.js";
import { getHeader } from "../http/types.js";
import type { Logger } from "../logging/logger.js";
import { consoleLogger } from "../logging/logger.js";
import { makeDpopReplayCache } from "./dpop-replay-cache.js";
import type { OwnerAuthService } from "./owner-auth.js";
import type { OwnerPrincipal } from "./owner-principal.js";

/**
 * Extended claim bag: IdP access tokens may include profile claims (nickname)
 * beyond the typed AccessTokenClaims surface. We never require email.
 */
type ClaimsBag = AccessTokenClaims & {
  readonly iss?: string;
  readonly nickname?: string;
  readonly [key: string]: unknown;
};

/** Reasons returned by `@ericminassian/auth` authenticateRequest failures. */
export type AuthFailureReason = "missing" | "invalid" | "expired";

/**
 * Build a production OwnerAuth backed by `@ericminassian/auth/server`.
 * DPoP mode `"auto"`: bound tokens cannot be downgraded to bare bearer.
 * Process-local `isReplay` cache for proof jti (see dpop-replay-cache.ts).
 */
export function makeEricminassianOwnerAuth(
  config: Pick<ApiConfig, "authIssuer" | "authAudience">,
  getRequest: () => HttpRequest,
  verifier: AuthVerifier = createDefaultVerifier(config),
  logger: Logger = consoleLogger,
): OwnerAuthService {
  return {
    requireOwner: () =>
      Effect.gen(function* () {
        let req: HttpRequest;
        try {
          req = getRequest();
        } catch (cause) {
          // Programming error (no active request) — not an auth failure.
          // Client gets a generic 500; cause is logged server-side only.
          return yield* Effect.fail(
            internalFromCause(cause, { component: "owner_auth_get_request" }, logger),
          );
        }

        let fetchRequest: Request;
        try {
          fetchRequest = toFetchRequest(req);
        } catch (cause) {
          return yield* Effect.fail(
            internalFromCause(
              cause,
              { component: "owner_auth_to_fetch_request" },
              logger,
            ),
          );
        }

        const result = yield* Effect.tryPromise({
          try: () => verifier.authenticateRequest(fetchRequest),
          catch: (cause) =>
            internalFromCause(
              cause,
              { component: "owner_auth_authenticate_request" },
              logger,
            ),
        });

        if (!result.authenticated) {
          return yield* Effect.fail(
            AppError.unauthorized(
              authFailureMessage(result.reason),
              result.wwwAuthenticate,
            ),
          );
        }

        return toOwnerPrincipal(result.claims, config.authIssuer);
      }),
  };
}

function createDefaultVerifier(
  config: Pick<ApiConfig, "authIssuer" | "authAudience">,
): AuthVerifier {
  return createAuthVerifier({
    audience: config.authAudience,
    issuer: config.authIssuer,
    dpop: {
      mode: "auto",
      // Single-use proofs within this process. Multi-instance: see dpop-replay-cache.
      isReplay: makeDpopReplayCache(300),
    },
  });
}

export function authFailureMessage(reason: AuthFailureReason): string {
  switch (reason) {
    case "missing":
      return "Missing access token";
    case "invalid":
      // SDK folds expiry and signature failures into "invalid" in practice;
      // keep "expired" for typed completeness if the SDK surfaces it later.
      return "Invalid access token";
    case "expired":
      return "Access token expired";
  }
}

export function toOwnerPrincipal(
  claims: AccessTokenClaims,
  defaultIss: string,
): OwnerPrincipal {
  const bag = claims as ClaimsBag;
  const nickname =
    typeof bag.nickname === "string" && bag.nickname.length > 0
      ? bag.nickname
      : undefined;
  const iss =
    typeof bag.iss === "string" && bag.iss.length > 0 ? bag.iss : defaultIss;

  return {
    sub: claims.sub,
    iss,
    nickname,
    sid: claims.sid,
    scope: claims.scope,
    jti: claims.jti,
    acr: claims.acr,
    claims: { ...bag },
  };
}

/**
 * Reconstruct a Fetch API Request so DPoP proof binds to method + absolute URL.
 */
export function toFetchRequest(req: HttpRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  // Cookie header is not always in headers map after APIGW parsing.
  if (!headers.has("cookie") && Object.keys(req.cookies).length > 0) {
    headers.set(
      "cookie",
      Object.entries(req.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  // Ensure Authorization is present if the adapter put it only in multiValue.
  const auth = getHeader(req.headers, "authorization");
  if (auth !== undefined && !headers.has("authorization")) {
    headers.set("authorization", auth);
  }

  return new Request(req.url, {
    method: req.method,
    headers,
    body:
      req.body !== undefined &&
      req.method !== "GET" &&
      req.method !== "HEAD"
        ? req.body
        : undefined,
  });
}

/** Exported for tests that inject a custom AuthVerifier. */
export type { AuthVerifier };
