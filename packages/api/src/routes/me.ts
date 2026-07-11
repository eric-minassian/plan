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
