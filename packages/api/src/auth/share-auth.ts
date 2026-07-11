import { SHARE_COOKIE_NAME } from "@tripplan/domain";
import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import {
  isGrantUsable,
  isSessionUsable,
  type ShareRepository,
} from "../repos/share-repo.js";
import type { TripRepository } from "../repos/trip-repo.js";

/** Re-export domain cookie name so API consumers have a single import path. */
export { SHARE_COOKIE_NAME };

/**
 * Principal once a share session is revalidated against grant + trip.
 */
export interface SharePrincipal {
  readonly sessionId: string;
  readonly tripId: string;
  readonly shareId: string;
  readonly ownerId: string;
}

/**
 * Share auth middleware — revalidates cookie against session store + grant + trip
 * on every request (design: immediate revoke / 410 on trip delete).
 */
export interface ShareAuthService {
  readonly requireShare: () => Effect.Effect<SharePrincipal, AppError>;
}

export class ShareAuth extends Context.Tag("ShareAuth")<
  ShareAuth,
  ShareAuthService
>() {}

export interface MakeShareAuthOptions {
  readonly getCookie: () => string | undefined;
  readonly shareRepo: ShareRepository;
  readonly tripRepo: TripRepository;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

/**
 * Real share auth: session → grant → trip revalidation every request.
 *
 * 1. Get session — miss / expired → 401
 * 2. Get grant — missing / revoked / expired → 401
 * 3. Get trip — missing / deleted / deleting → 410 Gone
 */
export function makeShareAuth(options: MakeShareAuthOptions): ShareAuthService {
  const now = options.now ?? (() => new Date());
  return {
    requireShare: () =>
      Effect.gen(function* () {
        const sessionId = options.getCookie();
        if (sessionId === undefined || sessionId.length === 0) {
          return yield* Effect.fail(
            AppError.unauthorized("Share session required"),
          );
        }

        const session = yield* options.shareRepo.getSession(sessionId);
        if (session === undefined || !isSessionUsable(session, now())) {
          return yield* Effect.fail(
            AppError.unauthorized("Share session invalid or expired"),
          );
        }

        const grant = yield* options.shareRepo.getGrant(
          session.tripId,
          session.shareId,
        );
        if (grant === undefined || !isGrantUsable(grant, now())) {
          return yield* Effect.fail(
            AppError.unauthorized("Share grant revoked or expired"),
          );
        }

        const trip = yield* options.tripRepo.getByTripId(session.tripId);
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

        const principal: SharePrincipal = {
          sessionId: session.sessionId,
          tripId: session.tripId,
          shareId: session.shareId,
          ownerId: grant.ownerId,
        };
        return principal;
      }),
  };
}

/**
 * Stub that always fails after cookie presence check — retained for tests.
 * Prefer {@link makeShareAuth} in production.
 */
export function makeShareAuthStub(
  getCookie: () => string | undefined,
): ShareAuthService {
  return {
    requireShare: () =>
      Effect.gen(function* () {
        const sessionId = getCookie();
        if (sessionId === undefined || sessionId.length === 0) {
          return yield* Effect.fail(
            AppError.unauthorized("Share session required"),
          );
        }
        return yield* Effect.fail(
          AppError.unauthorized("Share session revalidation not implemented"),
        );
      }),
  };
}
