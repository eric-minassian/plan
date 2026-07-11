import {
  CreateShareGrant,
  CreateShareSession,
  SHARE_OWNER_DISPLAY_FALLBACK,
  SHARE_PATH,
  toShareGrantPublic,
  type ShareTripDTO,
} from "@tripplan/domain";
import { Effect, Either } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import { CurrentShare } from "../auth/current-share.js";
import { SHARE_COOKIE_NAME } from "../auth/share-auth.js";
import { AppError } from "../errors/app-error.js";
import { decodeJsonBody } from "../http/decode.js";
import {
  buildShareSessionCookie,
  clearShareSessionCookie,
} from "../http/share-cookie.js";
import { RequestContext } from "../http/request-context.js";
import {
  getHeader,
  jsonResponse,
  type HttpResponse,
} from "../http/types.js";
import {
  isGrantUsable,
  ShareRepo,
} from "../repos/share-repo.js";
import { hashShareToken } from "../repos/share-token.js";
import { TripRepo } from "../repos/trip-repo.js";
import { UserRepo } from "../repos/user-repo.js";
import type { makeShareSessionRateLimiter } from "../http/rate-limit.js";

function requirePathParam(
  params: Readonly<Record<string, string>>,
  name: string,
): Effect.Effect<string, AppError> {
  const value = params[name];
  if (value === undefined || value.length === 0) {
    return Effect.fail(AppError.validation(`Missing path parameter: ${name}`));
  }
  return Effect.succeed(value);
}

export type ShareSessionRateLimiter = ReturnType<
  typeof makeShareSessionRateLimiter
>;

/**
 * Origin allowlist for POST /share/session.
 *
 * - Empty allowlist → not enforced (unit tests / local without PUBLIC_API_BASE_URL).
 * - Browser fetches send `Origin` (and often `Sec-Fetch-Site`); when either is
 *   present, Origin is required and must match the allowlist.
 * - Non-browser clients that omit both headers may still exchange a capability
 *   token (token is the secret; allowlist is anti-CSRF for browsers).
 */
export function isAllowedShareOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  secFetchSite?: string | undefined,
): boolean {
  if (allowedOrigins.length === 0) {
    return true;
  }
  const hasBrowserHint =
    (origin !== undefined && origin.length > 0) ||
    (secFetchSite !== undefined && secFetchSite.length > 0);

  if (!hasBrowserHint) {
    // curl / integration tests without Origin.
    return true;
  }
  if (origin === undefined || origin.length === 0) {
    // Sec-Fetch-Site present but Origin missing — treat as browser; require Origin.
    return false;
  }
  return allowedOrigins.includes(origin);
}

/** POST /api/v1/trips/:tripId/shares — create grant (raw token once). */
export function handleCreateShare(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | ShareRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const shares = yield* ShareRepo;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");

    const trip = yield* trips.getActiveForOwner(principal.sub, tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.notFound("Trip not found"));
    }

    const rawBody =
      request.body === undefined || request.body.trim().length === 0
        ? "{}"
        : request.body;
    const decoded = decodeJsonBody(CreateShareGrant, rawBody);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    const { grant, rawToken } = yield* shares.createGrant(
      principal.sub,
      tripId,
      decoded.right,
    );

    return jsonResponse(201, {
      shareId: grant.shareId,
      token: rawToken,
      path: SHARE_PATH,
      expiresAt: grant.expiresAt,
      label: grant.label,
    });
  });
}

/** GET /api/v1/trips/:tripId/shares — list grants (no raw tokens). */
export function handleListShares(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | ShareRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const shares = yield* ShareRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");

    const trip = yield* trips.getActiveForOwner(principal.sub, tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.notFound("Trip not found"));
    }

    const grants = yield* shares.listGrants(tripId);
    return jsonResponse(200, {
      shares: grants.map(toShareGrantPublic),
    });
  });
}

/** DELETE /api/v1/trips/:tripId/shares/:shareId — revoke + delete sessions. */
export function handleRevokeShare(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | ShareRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const trips = yield* TripRepo;
    const shares = yield* ShareRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const shareId = yield* requirePathParam(pathParams, "shareId");

    const trip = yield* trips.getActiveForOwner(principal.sub, tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.notFound("Trip not found"));
    }

    yield* shares.revokeGrant(principal.sub, tripId, shareId);
    return { status: 204 };
  });
}

export interface HandleCreateShareSessionOptions {
  readonly rateLimiter: ShareSessionRateLimiter;
  readonly allowedOrigins: readonly string[];
  readonly now?: () => Date;
}

/**
 * POST /api/v1/share/session — exchange raw token → HttpOnly cookie.
 * Public; rate-limited per IP; Origin checked when allowlist configured.
 *
 * Token-validity responses are intentionally uniform **401** (including when
 * the underlying trip is deleted) so exchange does not oracle “was a real grant
 * for a now-gone trip.” Authenticated share GETs still return **410 Gone**.
 */
export function handleCreateShareSession(
  options: HandleCreateShareSessionOptions,
): () => Effect.Effect<
  HttpResponse,
  AppError,
  ShareRepo | TripRepo | RequestContext
> {
  return () =>
    Effect.gen(function* () {
      const shares = yield* ShareRepo;
      const trips = yield* TripRepo;
      const { request } = yield* RequestContext;
      const now = options.now ?? (() => new Date());

      const origin = getHeader(request.headers, "origin");
      const secFetchSite = getHeader(request.headers, "sec-fetch-site");
      if (
        !isAllowedShareOrigin(origin, options.allowedOrigins, secFetchSite)
      ) {
        return yield* Effect.fail(AppError.forbidden("Origin not allowed"));
      }

      try {
        options.rateLimiter.check(request.clientIp);
      } catch (e) {
        if (e instanceof AppError) {
          return yield* Effect.fail(e);
        }
        return yield* Effect.fail(AppError.internal());
      }

      const decoded = decodeJsonBody(CreateShareSession, request.body);
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(decoded.left);
      }

      const tokenHash = hashShareToken(decoded.right.token);
      const grant = yield* shares.findGrantByTokenHash(tokenHash);
      if (grant === undefined || !isGrantUsable(grant, now())) {
        return yield* Effect.fail(
          AppError.unauthorized("Invalid or expired share token"),
        );
      }

      const trip = yield* trips.getByTripId(grant.tripId);
      // Uniform 401 on exchange — no 410 oracle for deleted trips (issue 6).
      if (
        trip === undefined ||
        trip.status === "deleted" ||
        trip.status === "deleting" ||
        trip.deletedAt !== undefined
      ) {
        return yield* Effect.fail(
          AppError.unauthorized("Invalid or expired share token"),
        );
      }

      // Replace previous session only when the cookie binds a real session.
      const previous = request.cookies[SHARE_COOKIE_NAME];
      if (previous !== undefined && previous.length > 0) {
        const existing = yield* shares.getSession(previous);
        if (existing !== undefined) {
          yield* shares.deleteSession(previous);
        }
      }

      const session = yield* shares.createSession(
        grant.tripId,
        grant.shareId,
        now(),
      );

      return {
        status: 204,
        cookies: [buildShareSessionCookie(session.sessionId)],
      };
    });
}

/** DELETE /api/v1/share/session — clear cookie + delete session. */
export function handleDeleteShareSession(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentShare | ShareRepo
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentShare;
    const shares = yield* ShareRepo;
    yield* shares.deleteSession(principal.sessionId);
    return {
      status: 204,
      cookies: [clearShareSessionCookie()],
    };
  });
}

/**
 * GET /api/v1/share/trip — read-only ShareTripDTO (no attachments).
 * Auth gate already revalidated grant + trip; re-load trip/items for DTO.
 * Never puts ownerId in the response body.
 */
export function handleGetShareTrip(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentShare | TripRepo | UserRepo | ShareRepo
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentShare;
    const trips = yield* TripRepo;
    const users = yield* UserRepo;

    const trip = yield* trips.getByTripId(principal.tripId);
    if (trip === undefined) {
      return yield* Effect.fail(AppError.gone("Trip is no longer available"));
    }
    if (
      trip.status === "deleted" ||
      trip.status === "deleting" ||
      trip.deletedAt !== undefined
    ) {
      return yield* Effect.fail(AppError.gone("Trip is no longer available"));
    }

    const items = yield* trips.listItemsByTripId(principal.tripId);
    const profile = yield* users.getByUserId(principal.ownerId);
    // Never fall back to ownerId (OIDC sub) — privacy: share DTO must not leak it.
    const ownerDisplayName =
      profile?.displayName !== undefined && profile.displayName.length > 0
        ? profile.displayName
        : SHARE_OWNER_DISPLAY_FALLBACK;

    const body: ShareTripDTO = {
      tripId: trip.tripId,
      title: trip.title,
      timezone: trip.timezone,
      startDate: trip.startDate,
      endDate: trip.endDate,
      ownerDisplayName,
      items,
    };
    return jsonResponse(200, body);
  });
}
