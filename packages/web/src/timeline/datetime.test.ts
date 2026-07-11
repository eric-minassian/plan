import { describe, expect, it } from "vitest";
import {
  formatCivilDateLabel,
  formatInstantInZone,
  instantToWallClockLocal,
  parseWallClock,
  wallClockInZoneToInstant,
} from "./datetime.ts";

describe("parseWallClock", () => {
  it("parses minute and second precision", () => {
    expect(parseWallClock("2026-06-01T10:30")).toEqual({
      year: 2026,
      month: 6,
      day: 1,
      hour: 10,
      minute: 30,
      second: 0,
    });
    expect(parseWallClock("2026-06-01T10:30:45")).toMatchObject({
      second: 45,
    });
  });

  it("rejects bad shapes", () => {
    expect(parseWallClock("2026-06-01")).toBeUndefined();
    expect(parseWallClock("not-a-date")).toBeUndefined();
  });
});

describe("wallClockInZoneToInstant", () => {
  it("converts Tokyo wall clock with +09:00", () => {
    const instant = wallClockInZoneToInstant(
      "2026-06-01T10:00",
      "Asia/Tokyo",
    );
    expect(instant).toBe("2026-06-01T10:00:00+09:00");
  });

  it("converts UTC wall clock with Z", () => {
    expect(wallClockInZoneToInstant("2026-06-01T12:00", "UTC")).toBe(
      "2026-06-01T12:00:00Z",
    );
  });

  it("handles US Eastern (DST) offset", () => {
    // June is EDT (−04:00)
    const instant = wallClockInZoneToInstant(
      "2026-06-15T08:00",
      "America/New_York",
    );
    expect(instant).toBe("2026-06-15T08:00:00-04:00");
  });

  it("handles US Eastern standard time", () => {
    // January is EST (−05:00)
    const instant = wallClockInZoneToInstant(
      "2026-01-15T08:00",
      "America/New_York",
    );
    expect(instant).toBe("2026-01-15T08:00:00-05:00");
  });

  it("documents fall-back ambiguous hour resolution (one offset)", () => {
    // 2026-11-01 01:30 America/New_York is ambiguous (EDT then EST).
    // Implementation picks one stable offset without user choice (v1).
    const instant = wallClockInZoneToInstant(
      "2026-11-01T01:30",
      "America/New_York",
    );
    expect(instant === "2026-11-01T01:30:00-04:00" ||
      instant === "2026-11-01T01:30:00-05:00").toBe(true);
  });

  it("returns undefined for invalid zone", () => {
    expect(
      wallClockInZoneToInstant("2026-06-01T10:00", "Not/A_Zone"),
    ).toBeUndefined();
  });

  it("returns undefined for bad wall string", () => {
    expect(wallClockInZoneToInstant("nope", "UTC")).toBeUndefined();
  });
});

describe("instantToWallClockLocal", () => {
  it("round-trips with wallClockInZoneToInstant", () => {
    const wall = "2026-06-01T14:30";
    const zone = "Europe/Lisbon";
    const instant = wallClockInZoneToInstant(wall, zone);
    expect(instant).toBeDefined();
    if (instant === undefined) {
      return;
    }
    expect(instantToWallClockLocal(instant, zone)).toBe(wall);
  });

  it("returns empty for missing/invalid", () => {
    expect(instantToWallClockLocal(undefined, "UTC")).toBe("");
    expect(instantToWallClockLocal("not-an-instant", "UTC")).toBe("");
  });
});

describe("formatInstantInZone", () => {
  it("formats in trip zone", () => {
    const label = formatInstantInZone("2026-06-01T10:00:00+09:00", "Asia/Tokyo");
    expect(label).toMatch(/Jun/);
    expect(label).toMatch(/10:00/);
  });
});

describe("formatCivilDateLabel", () => {
  it("formats civil date", () => {
    expect(formatCivilDateLabel("2026-06-01")).toMatch(/Jun/);
    expect(formatCivilDateLabel("2026-06-01")).toMatch(/2026/);
  });
});
