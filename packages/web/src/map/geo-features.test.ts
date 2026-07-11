import type { ItineraryItem } from "@tripplan/domain";
import { describe, expect, it } from "vitest";
import { createAirportsIndex } from "./airports.ts";
import {
  buildTripMapModel,
  filterMapModel,
  greatCircleCoordinates,
  itemHasMapGeo,
  UNSCHEDULED_DAY_KEY,
} from "./geo-features.ts";

function baseFields(partial: {
  readonly itemId: string;
  readonly title: string;
  readonly startAt?: string;
  readonly sortKey?: number;
}) {
  return {
    itemId: partial.itemId,
    tripId: "t1",
    title: partial.title,
    startAt: partial.startAt,
    sortKey: partial.sortKey ?? 1000,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function note(partial: {
  readonly itemId: string;
  readonly title: string;
  readonly startAt?: string;
  readonly startLocation?: ItineraryItem["startLocation"];
  readonly endLocation?: ItineraryItem["endLocation"];
}): ItineraryItem {
  return {
    ...baseFields(partial),
    type: "note",
    notes: "body",
    details: {},
    startLocation: partial.startLocation,
    endLocation: partial.endLocation,
  };
}

function flight(partial: {
  readonly itemId: string;
  readonly title: string;
  readonly startAt: string;
  readonly departureAirport?: string;
  readonly arrivalAirport?: string;
  readonly startLocation?: ItineraryItem["startLocation"];
  readonly endLocation?: ItineraryItem["endLocation"];
}): ItineraryItem {
  return {
    ...baseFields(partial),
    type: "flight",
    startLocation: partial.startLocation,
    endLocation: partial.endLocation,
    details: {
      flightNumber: "100",
      departureAirport: partial.departureAirport,
      arrivalAirport: partial.arrivalAirport,
    },
  };
}

const airports = createAirportsIndex([
  { iata: "SFO", lat: 37.62, lng: -122.38, name: "San Francisco" },
  { iata: "NRT", lat: 35.76, lng: 140.39, name: "Narita" },
]);

function normalizeLng(lng: number): number {
  const n = ((((lng + 180) % 360) + 360) % 360) - 180;
  return n;
}

describe("buildTripMapModel", () => {
  it("omits items without geo or resolvable airports", () => {
    const model = buildTripMapModel({
      items: [
        note({ itemId: "n1", title: "Pack", startAt: "2026-06-01T09:00:00Z" }),
        flight({
          itemId: "f1",
          title: "Unknown",
          startAt: "2026-06-02T10:00:00Z",
          departureAirport: "ZZZ",
          arrivalAirport: "YYY",
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
      airports,
    });
    expect(model.hasGeo).toBe(false);
    expect(model.pins).toHaveLength(0);
    expect(model.arcs).toHaveLength(0);
  });

  it("resolves flight airports via IATA and draws an arc", () => {
    const model = buildTripMapModel({
      items: [
        flight({
          itemId: "f1",
          title: "SFO→NRT",
          startAt: "2026-06-05T10:00:00Z",
          departureAirport: "sfo",
          arrivalAirport: "NRT",
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
      airports,
    });
    expect(model.hasGeo).toBe(true);
    expect(model.pins).toHaveLength(2);
    expect(model.pins.map((p) => p.role)).toEqual(["start", "end"]);
    expect(model.arcs).toHaveLength(1);
    expect(model.days).toHaveLength(1);
    expect(model.days[0]?.dayNumber).toBe(5);
  });

  it("prefers explicit locations over IATA", () => {
    const model = buildTripMapModel({
      items: [
        flight({
          itemId: "f1",
          title: "Custom",
          startAt: "2026-06-01T10:00:00Z",
          departureAirport: "SFO",
          arrivalAirport: "NRT",
          startLocation: { lat: 1, lng: 2, label: "Gate A" },
          endLocation: { lat: 3, lng: 4, label: "Gate B" },
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
      airports,
    });
    expect(model.pins[0]?.lat).toBe(1);
    expect(model.pins[0]?.label).toBe("Gate A");
    expect(model.pins[1]?.lat).toBe(3);
  });

  it("uses note startLocation as a single pin", () => {
    const model = buildTripMapModel({
      items: [
        note({
          itemId: "n1",
          title: "Cafe",
          startAt: "2026-06-03T12:00:00Z",
          startLocation: { lat: 35.68, lng: 139.76, label: "Shibuya" },
        }),
      ],
      tripTimezone: "Asia/Tokyo",
      tripStartDate: "2026-06-01",
      airports,
    });
    expect(model.pins).toHaveLength(1);
    expect(model.arcs).toHaveLength(0);
    expect(model.pins[0]?.dayNumber).toBe(3);
  });

  it("de-dupes hotel-style same start/end coordinates", () => {
    const model = buildTripMapModel({
      items: [
        note({
          itemId: "h1",
          title: "Hotel",
          startAt: "2026-06-01T15:00:00Z",
          startLocation: { lat: 35.68, lng: 139.76, label: "Park" },
          endLocation: { lat: 35.68, lng: 139.76, label: "Park" },
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
    });
    expect(model.pins).toHaveLength(1);
    expect(model.arcs).toHaveLength(0);
  });

  it("tracks unscheduled geo pins", () => {
    const model = buildTripMapModel({
      items: [
        note({
          itemId: "n1",
          title: "Loose",
          startLocation: { lat: 1, lng: 2 },
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
    });
    expect(model.unscheduledPinCount).toBe(1);
    expect(model.days).toHaveLength(0);
  });
});

describe("filterMapModel", () => {
  it("filters pins and arcs by selected day keys", () => {
    const model = buildTripMapModel({
      items: [
        note({
          itemId: "n1",
          title: "D1",
          startAt: "2026-06-01T12:00:00Z",
          startLocation: { lat: 1, lng: 1 },
        }),
        note({
          itemId: "n2",
          title: "D2",
          startAt: "2026-06-02T12:00:00Z",
          startLocation: { lat: 2, lng: 2 },
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
    });
    const filtered = filterMapModel(model, new Set(["2026-06-02"]));
    expect(filtered.pins).toHaveLength(1);
    expect(filtered.pins[0]?.itemId).toBe("n2");
  });

  it("includes unscheduled pins only when the unscheduled key is selected", () => {
    const model = buildTripMapModel({
      items: [
        note({
          itemId: "loose",
          title: "Loose",
          startLocation: { lat: 1, lng: 1 },
        }),
        note({
          itemId: "day",
          title: "Day",
          startAt: "2026-06-01T12:00:00Z",
          startLocation: { lat: 2, lng: 2 },
        }),
      ],
      tripTimezone: "UTC",
      tripStartDate: "2026-06-01",
    });
    const onlyDay = filterMapModel(model, new Set(["2026-06-01"]));
    expect(onlyDay.pins.map((p) => p.itemId)).toEqual(["day"]);

    const onlyUnsched = filterMapModel(
      model,
      new Set([UNSCHEDULED_DAY_KEY]),
    );
    expect(onlyUnsched.pins.map((p) => p.itemId)).toEqual(["loose"]);
  });
});

describe("itemHasMapGeo", () => {
  it("detects geo vs timeline-only", () => {
    expect(
      itemHasMapGeo(note({ itemId: "n1", title: "x" }), airports),
    ).toBe(false);
    expect(
      itemHasMapGeo(
        flight({
          itemId: "f1",
          title: "x",
          startAt: "2026-06-01T00:00:00Z",
          departureAirport: "SFO",
        }),
        airports,
      ),
    ).toBe(true);
  });
});

describe("greatCircleCoordinates", () => {
  it("returns endpoints and intermediate points", () => {
    const coords = greatCircleCoordinates(
      { lng: -122.38, lat: 37.62 },
      { lng: 140.39, lat: 35.76 },
      8,
    );
    expect(coords).toHaveLength(9);
    expect(coords[0]?.[0]).toBeCloseTo(-122.38, 2);
    const end = coords[8];
    expect(end).toBeDefined();
    if (end !== undefined) {
      expect(normalizeLng(end[0])).toBeCloseTo(140.39, 1);
      expect(end[1]).toBeCloseTo(35.76, 1);
    }
  });

  it("unwraps longitudes so SFO→NRT never jumps across the antimeridian", () => {
    const coords = greatCircleCoordinates(
      { lng: -122.38, lat: 37.62 },
      { lng: 140.39, lat: 35.76 },
      48,
    );
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const cur = coords[i];
      if (prev === undefined || cur === undefined) {
        continue;
      }
      expect(Math.abs(cur[0] - prev[0])).toBeLessThanOrEqual(180);
    }
  });
});
