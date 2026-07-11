import type { ItineraryItem } from "@tripplan/domain";
import { describe, expect, it } from "vitest";
import {
  itemSubtitle,
  itemTypeBadgeVariant,
  itemTypeLabel,
} from "./item-display.ts";

const baseItem = {
  itemId: "i1",
  tripId: "t1",
  version: 1,
  sortKey: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("itemTypeLabel", () => {
  it("labels every itinerary type", () => {
    expect(itemTypeLabel("flight")).toBe("Flight");
    expect(itemTypeLabel("note")).toBe("Note");
    expect(itemTypeLabel("hotel")).toBe("Hotel");
    expect(itemTypeLabel("train")).toBe("Train");
    expect(itemTypeLabel("transport")).toBe("Transport");
    expect(itemTypeLabel("activity")).toBe("Activity");
    expect(itemTypeLabel("ticket")).toBe("Ticket");
    expect(itemTypeLabel("custom")).toBe("Custom");
  });
});

describe("itemTypeBadgeVariant", () => {
  it("maps flight and note to primary variants", () => {
    expect(itemTypeBadgeVariant("flight")).toBe("default");
    expect(itemTypeBadgeVariant("note")).toBe("secondary");
  });

  it("maps other types to outline", () => {
    expect(itemTypeBadgeVariant("hotel")).toBe("outline");
    expect(itemTypeBadgeVariant("activity")).toBe("outline");
  });
});

describe("itemSubtitle", () => {
  it("composes flight designator, route, and times", () => {
    const flight: Extract<ItineraryItem, { type: "flight" }> = {
      ...baseItem,
      type: "flight",
      title: "UA100",
      startAt: "2026-06-01T15:00:00.000Z",
      endAt: "2026-06-01T23:00:00.000Z",
      details: {
        flightNumber: "100",
        airlineCode: "UA",
        departureAirport: "SFO",
        arrivalAirport: "JFK",
      },
    };
    const sub = itemSubtitle(flight, "UTC");
    expect(sub).toContain("UA100");
    expect(sub).toContain("SFO → JFK");
    expect(sub).toMatch(/·/);
  });

  it("uses bare flight number when airline code is absent", () => {
    const flight: Extract<ItineraryItem, { type: "flight" }> = {
      ...baseItem,
      type: "flight",
      title: "100",
      startAt: undefined,
      endAt: undefined,
      details: {
        flightNumber: "100",
      },
    };
    expect(itemSubtitle(flight, "UTC")).toBe("100");
  });

  it("truncates long note bodies", () => {
    const body = "x".repeat(130);
    const note: Extract<ItineraryItem, { type: "note" }> = {
      ...baseItem,
      type: "note",
      title: "Pack",
      notes: body,
      details: {},
      startAt: undefined,
      endAt: undefined,
    };
    const sub = itemSubtitle(note, "UTC");
    expect(sub).toBeDefined();
    // body > 120 → first 117 chars + ellipsis
    expect(sub).toBe(`${"x".repeat(117)}…`);
    expect(sub?.endsWith("…")).toBe(true);
  });

  it("falls back to start time when note body is empty", () => {
    const note: Extract<ItineraryItem, { type: "note" }> = {
      ...baseItem,
      type: "note",
      title: "Pack",
      notes: "   ",
      details: {},
      startAt: "2026-06-01T12:00:00.000Z",
      endAt: undefined,
    };
    const sub = itemSubtitle(note, "UTC");
    expect(sub).toBeDefined();
    expect(sub?.length).toBeGreaterThan(0);
  });
});
