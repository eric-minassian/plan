import type { Instant } from "./instant.js";
import {
  assertValidTimeZone,
  civilDateDiffDays,
  InvalidTimeZoneError,
} from "./time.js";

/** Minimal item shape needed for day bucketing. */
export type BucketableItem = {
  readonly startAt?: Instant | undefined;
  readonly sortKey?: number | undefined;
};

export type DayBucket<T extends BucketableItem> = {
  /** Civil date YYYY-MM-DD in the trip timezone. */
  readonly date: string;
  /**
   * Day index for UI labeling.
   *
   * - Default: 1-based over **sorted unique civil dates present among items**
   *   (content days — a trip with items only on Jun 5 and Jun 7 yields Day 1 / Day 2).
   * - With `options.tripStartDate`: 1-based offset from that civil date
   *   (`dayNumber = (date - tripStartDate) + 1`), so Jun 5 on a Jun 1 start is Day 5.
   */
  readonly dayNumber: number;
  readonly items: readonly T[];
};

export type DayBucketResult<T extends BucketableItem> = {
  readonly days: readonly DayBucket<T>[];
  /** Items with no `startAt` (or unparseable instant). */
  readonly unscheduled: readonly T[];
};

export type BucketItemsByDayOptions = {
  /**
   * Trip civil start date (YYYY-MM-DD). When set, `dayNumber` is trip-relative
   * rather than a dense index over days that have content.
   */
  readonly tripStartDate?: string;
};

/**
 * Convert an Instant to a civil YYYY-MM-DD date in the given IANA timezone.
 * @throws {InvalidTimeZoneError} when `timeZone` is not a valid IANA identifier
 * @throws {RangeError} when `instant` is unparseable
 */
export function civilDateInTimeZone(instant: string, timeZone: string): string {
  assertValidTimeZone(timeZone);

  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid instant for day bucketing: ${instant}`);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`Failed to format civil date for zone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function compareItemsWithinDay<T extends BucketableItem>(a: T, b: T): number {
  const aStart = a.startAt;
  const bStart = b.startAt;
  if (aStart !== undefined && bStart !== undefined && aStart !== bStart) {
    return aStart < bStart ? -1 : 1;
  }
  if (aStart !== undefined && bStart === undefined) return -1;
  if (aStart === undefined && bStart !== undefined) return 1;

  const aKey = a.sortKey;
  const bKey = b.sortKey;
  if (aKey !== undefined && bKey !== undefined && aKey !== bKey) {
    return aKey - bKey;
  }
  return 0;
}

/**
 * Group items by civil date in the trip timezone.
 * Items without `startAt` (or with an unparseable instant) go to unscheduled.
 *
 * @throws {InvalidTimeZoneError} if `tripTimezone` is not a valid IANA zone —
 * never silently empties the timeline for a bad zone.
 */
export function bucketItemsByDay<T extends BucketableItem>(
  items: readonly T[],
  tripTimezone: string,
  options?: BucketItemsByDayOptions,
): DayBucketResult<T> {
  // Fail closed: invalid zone must not look like “everything unscheduled”.
  assertValidTimeZone(tripTimezone);

  const unscheduled: T[] = [];
  const byDate = new Map<string, T[]>();

  for (const item of items) {
    const startAt = item.startAt;
    if (startAt === undefined) {
      unscheduled.push(item);
      continue;
    }

    let date: string;
    try {
      date = civilDateInTimeZone(startAt, tripTimezone);
    } catch (error) {
      if (error instanceof InvalidTimeZoneError) {
        throw error;
      }
      // Only unparseable / bad instants land in unscheduled.
      unscheduled.push(item);
      continue;
    }

    const bucket = byDate.get(date);
    if (bucket === undefined) {
      byDate.set(date, [item]);
    } else {
      bucket.push(item);
    }
  }

  const sortedDates = [...byDate.keys()].sort();
  const tripStartDate = options?.tripStartDate;

  const days: DayBucket<T>[] = sortedDates.map((date, index) => {
    const dayItems = [...(byDate.get(date) ?? [])].sort(compareItemsWithinDay);
    const dayNumber =
      tripStartDate !== undefined
        ? civilDateDiffDays(tripStartDate, date) + 1
        : index + 1;
    return { date, dayNumber, items: dayItems };
  });

  return { days, unscheduled };
}
