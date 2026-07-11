/**
 * Shared helpers for itinerary item create/edit forms.
 */

import { wallClockInZoneToInstant } from "../timeline/datetime.ts";

/** Trim; empty string becomes `undefined` (omit optional fields). */
export function optionalTrim(value: string): string | undefined {
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Parse wall clock for create (omit empty) vs edit (null clears).
 */
export function parseOptionalInstant(
  wall: string,
  tripTimezone: string,
  label: string,
  clearOnEmpty: boolean,
):
  | { readonly ok: true; readonly value: string | null | undefined }
  | { readonly ok: false; readonly error: string } {
  if (wall.trim().length === 0) {
    return { ok: true, value: clearOnEmpty ? null : undefined };
  }
  const instant = wallClockInZoneToInstant(wall.trim(), tripTimezone);
  if (instant === undefined) {
    return {
      ok: false,
      error: `${label} is invalid for this trip timezone (check date/time)`,
    };
  }
  return { ok: true, value: instant };
}

/** Assign optional string detail keys only when non-empty after trim. */
export function assignOptionalDetails(
  details: Record<string, string>,
  entries: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [key, raw] of entries) {
    const value = optionalTrim(raw);
    if (value !== undefined) {
      details[key] = value;
    }
  }
}
