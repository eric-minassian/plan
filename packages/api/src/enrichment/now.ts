import { normalizeInstant, type Instant } from "@tripplan/domain";

/** Current time as a domain Instant (second precision, Z). */
export function nowInstant(now: Date = new Date()): Instant {
  const iso = now.toISOString();
  // toISOString is always `…sssZ`; strip fractional seconds via normalize.
  return normalizeInstant(iso);
}
