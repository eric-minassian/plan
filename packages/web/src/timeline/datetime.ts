/**
 * Wall-clock ↔ Instant helpers for trip-timezone forms.
 *
 * Domain Instant requires second precision + zone (`Z` or `±HH:MM`).
 * Forms use `datetime-local` values (`YYYY-MM-DDTHH:mm`) interpreted in the
 * trip IANA timezone, not the browser zone.
 */

const WALL_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type WallClockParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Parse `YYYY-MM-DDTHH:mm` / `YYYY-MM-DDTHH:mm:ss` wall clock. */
export function parseWallClock(wall: string): WallClockParts | undefined {
  const match = WALL_RE.exec(wall.trim());
  if (match === undefined || match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  if (
    [year, month, day, hour, minute, second].some((n) => !Number.isFinite(n))
  ) {
    return undefined;
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Offset (ms) such that `localMs = utcMs + offsetMs` for the given instant
 * when formatted in `timeZone` (DST-aware via Intl).
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));

    const num = (type: Intl.DateTimeFormatPartTypes): number | undefined => {
      const value = parts.find((p) => p.type === type)?.value;
      if (value === undefined) {
        return undefined;
      }
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };

    const year = num("year");
    const month = num("month");
    const day = num("day");
    const hour = num("hour");
    const minute = num("minute");
    const second = num("second");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      return undefined;
    }

    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return asUtc - utcMs;
  } catch {
    return undefined;
  }
}

function formatOffset(offsetMs: number): string {
  const totalMinutes = Math.round(offsetMs / 60_000);
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const hh = pad2(Math.floor(abs / 60));
  const mm = pad2(abs % 60);
  return `${sign}${hh}:${mm}`;
}

/**
 * Convert wall-clock civil time in `timeZone` to a domain Instant string
 * (`YYYY-MM-DDTHH:mm:ss±HH:MM` or `…Z`).
 *
 * Returns `undefined` when the wall string or zone is invalid, or when the
 * civil time does not exist (e.g. spring-forward gap) after resolution.
 */
export function wallClockInZoneToInstant(
  wall: string,
  timeZone: string,
): string | undefined {
  const parts = parseWallClock(wall);
  if (parts === undefined) {
    return undefined;
  }

  // Desired local as if it were UTC numbers — adjust by zone offset.
  const desiredLocalAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let utcMs = desiredLocalAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const offset = zoneOffsetMs(utcMs, timeZone);
    if (offset === undefined) {
      return undefined;
    }
    utcMs = desiredLocalAsUtc - offset;
  }

  const finalOffset = zoneOffsetMs(utcMs, timeZone);
  if (finalOffset === undefined) {
    return undefined;
  }

  // Verify the resolved instant formats back to the requested wall clock.
  const verify = instantToWallParts(utcMs, timeZone);
  if (
    verify === undefined ||
    verify.year !== parts.year ||
    verify.month !== parts.month ||
    verify.day !== parts.day ||
    verify.hour !== parts.hour ||
    verify.minute !== parts.minute ||
    verify.second !== parts.second
  ) {
    return undefined;
  }

  const offsetStr = formatOffset(finalOffset);
  const yyyy = pad4(parts.year);
  const mm = pad2(parts.month);
  const dd = pad2(parts.day);
  const hh = pad2(parts.hour);
  const mi = pad2(parts.minute);
  const ss = pad2(parts.second);
  // Prefer Z when offset is zero for a cleaner Instant.
  const zone = offsetStr === "+00:00" ? "Z" : offsetStr;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${zone}`;
}

function instantToWallParts(
  utcMs: number,
  timeZone: string,
): WallClockParts | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));

    const num = (type: Intl.DateTimeFormatPartTypes): number | undefined => {
      const value = parts.find((p) => p.type === type)?.value;
      if (value === undefined) {
        return undefined;
      }
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };

    const year = num("year");
    const month = num("month");
    const day = num("day");
    const hour = num("hour");
    const minute = num("minute");
    const second = num("second");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      return undefined;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return undefined;
  }
}

/**
 * Instant → `datetime-local` value (`YYYY-MM-DDTHH:mm`) in `timeZone`.
 * Returns empty string when the instant is unparseable.
 */
export function instantToWallClockLocal(
  instant: string | undefined,
  timeZone: string,
): string {
  if (instant === undefined || instant.length === 0) {
    return "";
  }
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    return "";
  }
  const parts = instantToWallParts(ms, timeZone);
  if (parts === undefined) {
    return "";
  }
  return `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * Format an Instant for display in the trip timezone
 * (e.g. `Jun 1, 10:00`).
 */
export function formatInstantInZone(
  instant: string | undefined,
  timeZone: string,
): string | undefined {
  if (instant === undefined || instant.length === 0) {
    return undefined;
  }
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return undefined;
  }
}

/** Format a civil YYYY-MM-DD for day headers (e.g. `Mon, Jun 1, 2026`). */
export function formatCivilDateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return date;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Noon UTC avoids edge civil-date drift when formatting with locale only.
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}
