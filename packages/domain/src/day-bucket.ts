import type { Instant } from "./instant.js";

/** Minimal item shape needed for day bucketing. */
export type BucketableItem = {
  readonly startAt?: Instant | undefined;
};

export type DayBucket<T extends BucketableItem> = {
  /** Civil date YYYY-MM-DD in the trip timezone. */
  readonly date: string;
  /** 1-based day index over sorted unique civil dates present in the input. */
  readonly dayNumber: number;
  readonly items: readonly T[];
};

export type DayBucketResult<T extends BucketableItem> = {
  readonly days: readonly DayBucket<T>[];
  /** Items with no `startAt` (or unparseable instant). */
  readonly unscheduled: readonly T[];
};

/**
 * Convert an Instant to a civil YYYY-MM-DD date in the given IANA timezone.
 */
export function civilDateInTimeZone(instant: string, timeZone: string): string {
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

/**
 * Group items by civil date in the trip timezone.
 * Items without `startAt` go to the unscheduled bucket.
 * Day numbers are 1-based over sorted unique civil dates among scheduled items.
 */
export function bucketItemsByDay<T extends BucketableItem>(
  items: readonly T[],
  tripTimezone: string,
): DayBucketResult<T> {
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
    } catch {
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
  const days: DayBucket<T>[] = sortedDates.map((date, index) => ({
    date,
    dayNumber: index + 1,
    items: byDate.get(date) ?? [],
  }));

  return { days, unscheduled };
}
