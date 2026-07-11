import { Schema as S } from "effect";

/**
 * Canonical stored Instant: ISO-8601 with offset or Z, second precision.
 * No fractional seconds on write.
 */
export const Instant = S.String.pipe(
  S.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/),
);
export type Instant = typeof Instant.Type;

/**
 * Input accept list before normalize (fractional seconds allowed).
 * Validated in {@link normalizeInstant}, not by bare regex alone.
 */
export const InstantInput = S.String;
export type InstantInput = typeof InstantInput.Type;

/**
 * RFC 3339-style allowlist: date-time with required zone (Z or ±HH:MM).
 * Optional fractional seconds are accepted then stripped.
 */
const INSTANT_INPUT_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class InstantParseError extends Error {
  readonly _tag = "InstantParseError" as const;

  constructor(readonly input: string, message?: string) {
    super(message ?? `Invalid instant (expected RFC 3339 with zone): ${input}`);
    this.name = "InstantParseError";
  }
}

/**
 * Parse an RFC 3339 variant and format to canonical Instant (second precision).
 * Rejects zoneless local datetimes and other non-allowlisted forms.
 */
export function normalizeInstant(input: string): Instant {
  const match = INSTANT_INPUT_RE.exec(input);
  if (match === null) {
    throw new InstantParseError(input);
  }

  const base = match[1];
  const offset = match[3];
  if (base === undefined || offset === undefined) {
    throw new InstantParseError(input);
  }

  // Validate calendar/clock components via Date (must be a real instant).
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new InstantParseError(input, `Unparseable instant: ${input}`);
  }

  const canonical = `${base}${offset}`;
  // Re-check against Instant pattern (always true for our construction, keeps type honest).
  if (!S.is(Instant)(canonical)) {
    throw new InstantParseError(input, `Failed to canonicalize instant: ${input}`);
  }
  return canonical;
}
