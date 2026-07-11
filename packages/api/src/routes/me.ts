import { Effect } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import type { AppError } from "../errors/app-error.js";
import { jsonResponse, type HttpResponse } from "../http/types.js";
import { UserRepo } from "../repos/user-repo.js";

/**
 * GET /api/v1/me — Owner authz (principal injected by router gate once).
 * Upserts user profile from JWT claims (userId=sub, displayName=nickname if present, iss).
 * Never requires email.
 */
export function handleMe(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | UserRepo
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const users = yield* UserRepo;
    const profile = yield* users.upsertFromPrincipal(principal);
    return jsonResponse(200, profile);
  });
}

/**
 * DELETE /api/v1/me — account purge fan-out stub.
 *
 * Future: list active/deleting trips for USER#sub and enqueue each on the
 * trip-delete queue (async cascade). IdP account deletion remains at
 * auth.ericminassian.com; this path covers TripPlan data purge for privacy.
 *
 * Stub returns 202 Accepted without enqueueing so clients can integrate early.
 */
export function handleDeleteMe(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    // Machine-readable status is not_implemented — do not treat as data gone.
    return jsonResponse(202, {
      status: "not_implemented",
      message:
        "Account purge fan-out is not fully implemented yet. TripPlan will async-purge owned trips when this ships; contact support for privacy requests in the meantime. Clients must not assume data is deleted on 202.",
      userId: principal.sub,
    });
  });
}
