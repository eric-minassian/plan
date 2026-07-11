import type { UserProfile } from "@tripplan/domain";
import { normalizeInstant } from "@tripplan/domain";
import { Context, Effect } from "effect";
import type { OwnerPrincipal } from "../auth/owner-principal.js";

/**
 * User profile repository boundary.
 *
 * Design key: `USER#userId` / `PROFILE` in the single-table DynamoDB.
 *
 * **Skeleton status:** runtime defaults to {@link makeInMemoryUserRepo} —
 * process-local, lost on cold start, not shared across Lambda instances.
 * ApiStack still sets `TABLE_NAME` and grants R/W so a Dynamo-backed
 * implementation can land without infra changes. Do not treat in-memory
 * upsert as production profile persistence.
 */
export interface UserRepository {
  /**
   * Upsert profile from verified JWT claims.
   * userId=sub, displayName=nickname when present, store iss. Never requires email.
   */
  readonly upsertFromPrincipal: (
    principal: OwnerPrincipal,
  ) => Effect.Effect<UserProfile, never>;

  readonly getByUserId: (
    userId: string,
  ) => Effect.Effect<UserProfile | undefined, never>;
}

export class UserRepo extends Context.Tag("UserRepo")<
  UserRepo,
  UserRepository
>() {}

/**
 * In-memory user store for unit tests and interim skeleton runtime.
 * Not durable — replace with DynamoDB before relying on profile continuity.
 */
export function makeInMemoryUserRepo(
  seed: Iterable<UserProfile> = [],
): UserRepository {
  const store = new Map<string, UserProfile>();
  for (const profile of seed) {
    store.set(profile.userId, profile);
  }

  return {
    upsertFromPrincipal: (principal) =>
      Effect.sync(() => {
        const existing = store.get(principal.sub);
        const now = normalizeInstant(new Date().toISOString());
        const displayName =
          principal.nickname !== undefined && principal.nickname.length > 0
            ? principal.nickname
            : (existing?.displayName ?? principal.sub);

        const profile: UserProfile = {
          userId: principal.sub,
          iss: principal.iss,
          displayName,
          createdAt: existing?.createdAt ?? now,
        };
        store.set(principal.sub, profile);
        return profile;
      }),

    getByUserId: (userId) => Effect.sync(() => store.get(userId)),
  };
}
