/**
 * Shared calendar / IANA timezone helpers for domain schemas.
 */

/** True when year/month/day form a real Gregorian civil date (UTC construction check). */
export function isValidCivilDateParts(
  year: number,
  month: number,
  day: number,
): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** True when wall-clock Y-M-D H:M:S is a real calendar date and valid clock time (no hour 24). */
export function isValidWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return false;
  }
  if (!isValidCivilDateParts(year, month, day)) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day &&
    dt.getUTCHours() === hour &&
    dt.getUTCMinutes() === minute &&
    dt.getUTCSeconds() === second
  );
}

/**
 * Returns true if `timeZone` is accepted by `Intl` as an IANA zone identifier.
 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) {
    return false;
  }
  try {
    // Throws RangeError for unknown zones in modern engines.
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export class InvalidTimeZoneError extends Error {
  readonly _tag = "InvalidTimeZoneError" as const;

  constructor(readonly timeZone: string) {
    super(`Invalid IANA time zone: ${timeZone}`);
    this.name = "InvalidTimeZoneError";
  }
}

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new InvalidTimeZoneError(timeZone);
  }
}

/** Difference in whole civil days between two YYYY-MM-DD strings (b - a). */
export function civilDateDiffDays(from: string, to: string): number {
  const fromMs = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const toMs = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((toMs - fromMs) / 86_400_000);
}
