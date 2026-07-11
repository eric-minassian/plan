import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";

/**
 * Share session cookie name (design: first-party on plan host).
 * Middleware revalidates grant + trip every request in a later PR.
 */
export const SHARE_COOKIE_NAME = "tripplan_share" as const;

/**
 * Placeholder principal once a share session is revalidated.
 * Filled by share session exchange (not in this PR).
 */
export interface SharePrincipal {
  readonly sessionId: string;
  readonly tripId: string;
  readonly shareId: string;
}

/**
 * Share auth middleware interface — stub for later fill-in.
 * Share routes do not require owner JWT; they use the HttpOnly cookie.
 */
export interface ShareAuthService {
  /**
   * Revalidate cookie `tripplan_share` against the session store and grant.
   * Currently always fails — implement when share session exchange lands.
   */
  readonly requireShare: () => Effect.Effect<SharePrincipal, AppError>;
}

export class ShareAuth extends Context.Tag("ShareAuth")<
  ShareAuth,
  ShareAuthService
>() {}

/**
 * Stub implementation: session revalidation not yet implemented.
 * Reserves the middleware surface without accepting any share cookie.
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
        // Cookie present but store revalidation is a later PR.
        return yield* Effect.fail(
          AppError.unauthorized(
            "Share session revalidation not implemented",
          ),
        );
      }),
  };
}
