import { Schema as S } from "effect";
import { isValidWallClock } from "./time.js";

/**
 * RFC 3339-style allowlist: date-time with required zone (Z or ±HH:MM).
 * Optional fractional seconds are accepted by {@link normalizeInstant} then stripped.
 */
const INSTANT_INPUT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const CANONICAL_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

export class InstantParseError extends Error {
  readonly _tag = "InstantParseError" as const;

  constructor(
    readonly input: string,
    message?: string,
  ) {
    super(message ?? `Invalid instant (expected RFC 3339 with zone): ${input}`);
    this.name = "InstantParseError";
  }
}

/**
 * Parse allowlisted RFC 3339 input and return second-precision canonical form,
 * or `null` if invalid (bad shape, invalid calendar/clock, or unparseable).
 *
 * Does not accept zoneless local datetimes. Rejects overflow dates (Feb 30)
 * and hour 24 rather than rolling them.
 */
export function tryCanonicalizeInstant(input: string): string | null {
  const match = INSTANT_INPUT_RE.exec(input);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];

  if (
    offset === undefined ||
    !isValidWallClock(year, month, day, hour, minute, second)
  ) {
    return null;
  }

  // Absolute-time gate (engine must accept the offset form).
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    return null;
  }

  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${offset}`;
}

/**
 * Canonical stored Instant: ISO-8601 with offset or Z, second precision,
 * real calendar/clock components. Prefer producing values only via
 * {@link normalizeInstant}.
 */
export const Instant = S.String.pipe(
  S.filter(
    (s) => tryCanonicalizeInstant(s) === s,
    {
      message: () =>
        "Invalid Instant (need ISO-8601 second precision with Z or ±HH:MM and a real calendar date)",
    },
  ),
);
export type Instant = typeof Instant.Type;

/**
 * Input accept list before normalize (fractional seconds allowed).
 * Validated in {@link normalizeInstant}, not by bare regex alone.
 */
export const InstantInput = S.String;
export type InstantInput = typeof InstantInput.Type;

/**
 * Parse an RFC 3339 variant and format to canonical Instant (second precision).
 * Rejects zoneless local datetimes, overflow dates, and invalid clock times.
 */
export function normalizeInstant(input: string): Instant {
  const canonical = tryCanonicalizeInstant(input);
  if (canonical === null) {
    throw new InstantParseError(input);
  }
  // Canonical form always satisfies Instant (same validation path).
  if (!CANONICAL_INSTANT_RE.test(canonical)) {
    throw new InstantParseError(input, `Failed to canonicalize instant: ${input}`);
  }
  return canonical as Instant;
}
