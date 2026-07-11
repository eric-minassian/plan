import {
  SHARE_SESSION_RATE_LIMIT_PER_HOUR,
} from "@tripplan/domain";
import { AppError } from "../errors/app-error.js";

export interface RateLimitWindow {
  count: number;
  windowStartMs: number;
}

/**
 * Simple fixed-window in-memory rate limiter (dogfood only).
 *
 * **Tracked debt (design: DDB token bucket 20/h/IP):** this is process-local.
 * Under multi-instance Lambda concurrency, effective limit ≈ N × warm instances.
 * Replace with a shared Dynamo conditional counter / token bucket before broader
 * share-link exposure (same track as enrich rate limits).
 */
export function makeInMemoryRateLimiter(options: {
  readonly maxPerWindow: number;
  readonly windowMs: number;
}): {
  readonly check: (key: string, nowMs?: number) => void;
  readonly reset: () => void;
} {
  const buckets = new Map<string, RateLimitWindow>();

  return {
    check: (key, nowMs = Date.now()) => {
      const existing = buckets.get(key);
      if (existing === undefined || nowMs - existing.windowStartMs >= options.windowMs) {
        buckets.set(key, { count: 1, windowStartMs: nowMs });
        return;
      }
      if (existing.count >= options.maxPerWindow) {
        throw AppError.rateLimited(
          `Rate limit exceeded (max ${String(options.maxPerWindow)} per hour)`,
        );
      }
      existing.count += 1;
    },
    reset: () => {
      buckets.clear();
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Unknown / missing client IP is bucketed tightly so many clients without
 * sourceIp cannot share an unlimited path. Known IPs get the design 20/h.
 */
const UNKNOWN_IP_MAX_PER_HOUR = 5;

/**
 * Share-session attempt limiter: 20/h per known IP; stricter for "unknown".
 * Still process-local — see debt note on {@link makeInMemoryRateLimiter}.
 */
export function makeShareSessionRateLimiter(): {
  readonly check: (key: string, nowMs?: number) => void;
  readonly reset: () => void;
} {
  const known = makeInMemoryRateLimiter({
    maxPerWindow: SHARE_SESSION_RATE_LIMIT_PER_HOUR,
    windowMs: HOUR_MS,
  });
  const unknown = makeInMemoryRateLimiter({
    maxPerWindow: UNKNOWN_IP_MAX_PER_HOUR,
    windowMs: HOUR_MS,
  });

  return {
    check: (key, nowMs) => {
      const normalized = key.trim().length > 0 ? key.trim() : "unknown";
      if (normalized === "unknown") {
        unknown.check("unknown", nowMs);
        return;
      }
      known.check(normalized, nowMs);
    },
    reset: () => {
      known.reset();
      unknown.reset();
    },
  };
}
