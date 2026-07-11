import {
  bucketItemsByDay,
  type DayBucketResult,
  type ItineraryItem,
} from "@tripplan/domain";

/**
 * Group trip items for the day timeline.
 * Uses trip-relative day numbers when `tripStartDate` is set.
 */
export function bucketTripItems(
  items: readonly ItineraryItem[],
  tripTimezone: string,
  tripStartDate: string,
): DayBucketResult<ItineraryItem> {
  return bucketItemsByDay(items, tripTimezone, { tripStartDate });
}
