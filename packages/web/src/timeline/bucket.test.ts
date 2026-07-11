import type { ItineraryItem } from "@tripplan/domain";
import { describe, expect, it } from "vitest";
import { bucketTripItems } from "./bucket.ts";

function note(
  partial: Pick<ItineraryItem, "itemId" | "title"> & {
    readonly startAt?: string;
    readonly sortKey?: number;
  },
): ItineraryItem {
  return {
    itemId: partial.itemId,
    tripId: "t1",
    type: "note",
    title: partial.title,
    startAt: partial.startAt,
    notes: "body",
    details: {},
    sortKey: partial.sortKey ?? 1000,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function flight(
  partial: Pick<ItineraryItem, "itemId" | "title"> & {
    readonly startAt: string;
    readonly sortKey?: number;
  },
): ItineraryItem {
  return {
    itemId: partial.itemId,
    tripId: "t1",
    type: "flight",
    title: partial.title,
    startAt: partial.startAt,
    details: { flightNumber: "100" },
    sortKey: partial.sortKey ?? 1000,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("bucketTripItems", () => {
  it("groups by civil day in trip timezone with trip-relative day numbers", () => {
    const items: ItineraryItem[] = [
      flight({
        itemId: "f1",
        title: "NH100",
        startAt: "2026-06-05T10:00:00+09:00",
        sortKey: 2000,
      }),
      note({
        itemId: "n1",
        title: "Pack",
        startAt: "2026-06-03T09:00:00+09:00",
        sortKey: 1000,
      }),
      note({ itemId: "n2", title: "Unscheduled" }),
    ];

    const result = bucketTripItems(items, "Asia/Tokyo", "2026-06-01");

    expect(result.days).toHaveLength(2);
    expect(result.days[0]?.date).toBe("2026-06-03");
    // trip start Jun 1 → Jun 3 is Day 3
    expect(result.days[0]?.dayNumber).toBe(3);
    expect(result.days[0]?.items.map((i) => i.itemId)).toEqual(["n1"]);

    expect(result.days[1]?.date).toBe("2026-06-05");
    expect(result.days[1]?.dayNumber).toBe(5);
    expect(result.days[1]?.items.map((i) => i.itemId)).toEqual(["f1"]);

    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]?.itemId).toBe("n2");
  });

  it("sorts items within a day by absolute Instant then sortKey", () => {
    const items: ItineraryItem[] = [
      note({
        itemId: "later",
        title: "Later",
        startAt: "2026-06-01T14:00:00+09:00",
        sortKey: 1000,
      }),
      note({
        itemId: "earlier",
        title: "Earlier",
        startAt: "2026-06-01T09:00:00+09:00",
        sortKey: 2000,
      }),
    ];

    const result = bucketTripItems(items, "Asia/Tokyo", "2026-06-01");
    expect(result.days[0]?.items.map((i) => i.itemId)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
