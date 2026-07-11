import { describe, expect, it } from "vitest";
import { bucketItemsByDay, civilDateInTimeZone } from "./day-bucket.js";
import { InvalidTimeZoneError } from "./time.js";

describe("civilDateInTimeZone", () => {
  it("converts UTC instant to civil date in trip timezone", () => {
    // 2024-01-02 02:00 UTC → still Jan 1 evening in LA
    expect(civilDateInTimeZone("2024-01-02T02:00:00Z", "America/Los_Angeles")).toBe(
      "2024-01-01",
    );
    expect(civilDateInTimeZone("2024-01-02T02:00:00Z", "UTC")).toBe("2024-01-02");
    expect(civilDateInTimeZone("2024-01-02T02:00:00Z", "Asia/Tokyo")).toBe(
      "2024-01-02",
    );
  });

  it("throws InvalidTimeZoneError for unknown IANA zones", () => {
    expect(() => civilDateInTimeZone("2024-01-01T00:00:00Z", "Not/A_Zone")).toThrow(
      InvalidTimeZoneError,
    );
  });
});

describe("bucketItemsByDay", () => {
  it("buckets by civil date in trip timezone and numbers content days", () => {
    const items = [
      { id: "a", startAt: "2024-06-10T18:00:00Z" as const }, // → June 11 Tokyo
      { id: "b", startAt: "2024-06-11T01:00:00Z" as const }, // → June 11 Tokyo
      { id: "c", startAt: "2024-06-12T00:00:00Z" as const }, // → June 12 Tokyo
    ];

    const result = bucketItemsByDay(items, "Asia/Tokyo");

    expect(result.unscheduled).toEqual([]);
    expect(result.days).toHaveLength(2);
    expect(result.days[0]).toMatchObject({
      date: "2024-06-11",
      dayNumber: 1,
    });
    expect(result.days[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.days[1]).toMatchObject({
      date: "2024-06-12",
      dayNumber: 2,
    });
  });

  it("uses trip-relative dayNumber when tripStartDate is provided", () => {
    const items = [
      { id: "a", startAt: "2024-06-05T12:00:00Z" as const },
      { id: "b", startAt: "2024-06-07T12:00:00Z" as const },
    ];
    const result = bucketItemsByDay(items, "UTC", {
      tripStartDate: "2024-06-01",
    });
    expect(result.days[0]).toMatchObject({ date: "2024-06-05", dayNumber: 5 });
    expect(result.days[1]).toMatchObject({ date: "2024-06-07", dayNumber: 7 });
  });

  it("sorts items within a day by absolute Instant then sortKey", () => {
    const items = [
      { id: "late", startAt: "2024-07-01T18:00:00Z" as const, sortKey: 1 },
      { id: "early", startAt: "2024-07-01T08:00:00Z" as const, sortKey: 9 },
    ];
    const result = bucketItemsByDay(items, "UTC");
    expect(result.days[0]?.items.map((i) => i.id)).toEqual(["early", "late"]);
  });

  it("orders mixed-offset Instants by absolute time within a Tokyo civil day", () => {
    // Both civil 2024-06-11 in Asia/Tokyo:
    // B = 2024-06-11T01:00:00+09:00 → 2024-06-10T16:00:00Z (earlier)
    // A = 2024-06-10T18:00:00Z      → 2024-06-11T03:00:00+09:00 (later)
    // Lexicographic string order would put A before B; absolute order is B then A.
    const items = [
      { id: "A", startAt: "2024-06-10T18:00:00Z" as const },
      { id: "B", startAt: "2024-06-11T01:00:00+09:00" as const },
    ];
    const result = bucketItemsByDay(items, "Asia/Tokyo");
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.date).toBe("2024-06-11");
    expect(result.days[0]?.items.map((i) => i.id)).toEqual(["B", "A"]);
  });

  it("places items without startAt into unscheduled", () => {
    const items = [
      { id: "note", title: "packing list" },
      { id: "flight", startAt: "2024-07-01T12:00:00Z" as const },
    ];

    const result = bucketItemsByDay(items, "UTC");

    expect(result.unscheduled).toEqual([{ id: "note", title: "packing list" }]);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.date).toBe("2024-07-01");
    expect(result.days[0]?.dayNumber).toBe(1);
    expect(result.days[0]?.items).toHaveLength(1);
  });

  it("returns empty days when all items are unscheduled", () => {
    const items: Array<{ id: string; startAt?: string }> = [
      { id: "1" },
      { id: "2" },
    ];
    const result = bucketItemsByDay(items, "Europe/Paris");
    expect(result.days).toEqual([]);
    expect(result.unscheduled).toHaveLength(2);
  });

  it("throws on invalid trip timezone instead of emptying the timeline", () => {
    const items = [{ id: "a", startAt: "2024-07-01T12:00:00Z" as const }];
    expect(() => bucketItemsByDay(items, "Fake/Zone")).toThrow(InvalidTimeZoneError);
  });
});
