import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";

/** Default: 60 enrich calls per hour per owner (design). */
export const DEFAULT_ENRICH_RATE_LIMIT_PER_HOUR = 60;

export interface EnrichRateLimiter {
  /**
   * Consume one enrich call for `userId`. Fails with RateLimited when over cap.
   */
  readonly take: (userId: string) => Effect.Effect<void, AppError>;
}

/**
 * Simple sliding-window rate limiter (in-memory, per Lambda instance).
 * Good enough for dogfood; DDB token bucket can replace later.
 */
export function makeInMemoryEnrichRateLimiter(
  limitPerHour: number = DEFAULT_ENRICH_RATE_LIMIT_PER_HOUR,
  now: () => number = () => Date.now(),
): EnrichRateLimiter {
  const windowMs = 60 * 60 * 1000;
  /** userId → timestamps of recent takes (ms). */
  const hits = new Map<string, number[]>();

  return {
    take(userId: string) {
      return Effect.sync(() => {
        const t = now();
        const cutoff = t - windowMs;
        const prev = hits.get(userId) ?? [];
        const recent = prev.filter((ts) => ts > cutoff);
        if (recent.length >= limitPerHour) {
          hits.set(userId, recent);
          const oldest = recent[0] ?? t;
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + windowMs - t) / 1000),
          );
          return {
            ok: false as const,
            retryAfterSeconds,
          };
        }
        recent.push(t);
        hits.set(userId, recent);
        return { ok: true as const };
      }).pipe(
        Effect.flatMap((result) =>
          result.ok
            ? Effect.void
            : Effect.fail(
                AppError.rateLimited(
                  `Enrich rate limit exceeded (${String(limitPerHour)}/hour)`,
                  {
                    limitPerHour,
                    retryAfterSeconds: result.retryAfterSeconds,
                  },
                ),
              ),
        ),
      );
    },
  };
}
