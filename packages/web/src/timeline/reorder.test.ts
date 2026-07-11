import { describe, expect, it } from "vitest";
import {
  canMoveInSection,
  dropWithinSection,
  moveItemRelativeTo,
  reorderWithinSection,
  sameStartAtGroup,
  swapAdjacent,
  visualOrderIds,
} from "./reorder.ts";

describe("visualOrderIds", () => {
  it("concatenates days then unscheduled", () => {
    const ids = visualOrderIds({
      days: [
        { items: [{ itemId: "d1a" }, { itemId: "d1b" }] },
        { items: [{ itemId: "d2a" }] },
      ],
      unscheduled: [{ itemId: "u1" }, { itemId: "u2" }],
    });
    expect(ids).toEqual(["d1a", "d1b", "d2a", "u1", "u2"]);
  });
});

describe("moveItemRelativeTo", () => {
  it("moves down onto next neighbor (drag B onto C)", () => {
    // [A, B, C] drag B onto C → [A, C, B]
    expect(moveItemRelativeTo(["A", "B", "C"], "B", "C")).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("moves up onto previous neighbor (drag C onto B)", () => {
    // [A, B, C] drag C onto B → [A, C, B]
    expect(moveItemRelativeTo(["A", "B", "C"], "C", "B")).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("moves down past multiple items", () => {
    expect(moveItemRelativeTo(["A", "B", "C", "D"], "A", "C")).toEqual([
      "B",
      "C",
      "A",
      "D",
    ]);
  });

  it("moves up to first position", () => {
    expect(moveItemRelativeTo(["A", "B", "C"], "C", "A")).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("returns undefined for identity / missing ids", () => {
    expect(moveItemRelativeTo(["A", "B"], "A", "A")).toBeUndefined();
    expect(moveItemRelativeTo(["A", "B"], "Z", "B")).toBeUndefined();
    expect(moveItemRelativeTo(["A", "B"], "A", "Z")).toBeUndefined();
  });
});

describe("swapAdjacent", () => {
  it("swaps up and down", () => {
    expect(swapAdjacent(["A", "B", "C"], "B", "up")).toEqual(["B", "A", "C"]);
    expect(swapAdjacent(["A", "B", "C"], "B", "down")).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  it("returns undefined at bounds", () => {
    expect(swapAdjacent(["A", "B"], "A", "up")).toBeUndefined();
    expect(swapAdjacent(["A", "B"], "B", "down")).toBeUndefined();
  });
});

describe("sameStartAtGroup / canMoveInSection", () => {
  it("treats missing startAt as one group", () => {
    expect(sameStartAtGroup(undefined, undefined)).toBe(true);
    expect(sameStartAtGroup("t1", undefined)).toBe(false);
    expect(sameStartAtGroup("t1", "t1")).toBe(true);
    expect(sameStartAtGroup("t1", "t2")).toBe(false);
  });

  it("allows moves only within equal startAt neighbors", () => {
    const section = [
      { itemId: "a", startAt: "t1" },
      { itemId: "b", startAt: "t1" },
      { itemId: "c", startAt: "t2" },
    ];
    expect(canMoveInSection(section, "a", "down")).toBe(true);
    expect(canMoveInSection(section, "b", "up")).toBe(true);
    expect(canMoveInSection(section, "b", "down")).toBe(false);
    expect(canMoveInSection(section, "c", "up")).toBe(false);
  });

  it("allows free reorder among unscheduled (no startAt)", () => {
    const section = [
      { itemId: "u1" },
      { itemId: "u2" },
      { itemId: "u3" },
    ];
    expect(canMoveInSection(section, "u2", "up")).toBe(true);
    expect(canMoveInSection(section, "u2", "down")).toBe(true);
  });
});

describe("reorderWithinSection / dropWithinSection", () => {
  const buckets = {
    days: [
      {
        items: [
          { itemId: "a", startAt: "t1" },
          { itemId: "b", startAt: "t1" },
          { itemId: "c", startAt: "t2" },
        ],
      },
      {
        items: [{ itemId: "d", startAt: "t3" }],
      },
    ],
    unscheduled: [{ itemId: "u1" }, { itemId: "u2" }],
  };

  it("swaps within same-time group and rebuilds full order", () => {
    expect(reorderWithinSection(buckets, 0, "a", "down")).toEqual([
      "b",
      "a",
      "c",
      "d",
      "u1",
      "u2",
    ]);
  });

  it("rejects cross-time and cross-day adjacent swaps", () => {
    expect(reorderWithinSection(buckets, 0, "b", "down")).toBeUndefined();
    expect(reorderWithinSection(buckets, 0, "c", "down")).toBeUndefined();
  });

  it("reorders unscheduled freely", () => {
    expect(reorderWithinSection(buckets, "unscheduled", "u1", "down")).toEqual(
      ["a", "b", "c", "d", "u2", "u1"],
    );
  });

  it("drag-down onto next neighbor within same-time group", () => {
    expect(dropWithinSection(buckets, 0, "a", "b")).toEqual([
      "b",
      "a",
      "c",
      "d",
      "u1",
      "u2",
    ]);
  });

  it("rejects drop onto different startAt", () => {
    expect(dropWithinSection(buckets, 0, "a", "c")).toBeUndefined();
  });

  it("rejects drop across sections", () => {
    expect(dropWithinSection(buckets, 0, "a", "u1")).toBeUndefined();
  });
});
