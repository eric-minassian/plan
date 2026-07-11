/**
 * Process-local DPoP proof `jti` replay cache for resource-server verification.
 *
 * Limitation: Lambda may run multiple concurrent instances; each has its own
 * cache. A proof can still be replayed once per instance within the TTL window.
 * Shared storage (Dynamo/Redis) is needed for multi-instance single-use guarantees.
 * Still raises the bar vs no replay checks (same-instance double-submit fails).
 */

export interface DpopReplayInput {
  readonly jti: string;
  readonly jkt: string;
  readonly iat: number;
}

/**
 * Returns `true` when this (jkt, jti) was already seen inside the TTL window
 * (i.e. the proof is a replay). First sighting records the entry and returns `false`.
 */
export function makeDpopReplayCache(
  ttlSeconds = 300,
): (input: DpopReplayInput) => boolean {
  const seen = new Map<string, number>();
  const ttlMs = ttlSeconds * 1000;

  return (input: DpopReplayInput): boolean => {
    const now = Date.now();
    const key = `${input.jkt}:${input.jti}`;
    const expiresAt = seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return true;
    }
    seen.set(key, now + ttlMs);

    // Opportunistic purge when the map grows (warm Lambda).
    if (seen.size > 512) {
      for (const [k, exp] of seen) {
        if (exp <= now) {
          seen.delete(k);
        }
      }
    }
    return false;
  };
}
