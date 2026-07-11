import { describe, expect, it } from "vitest";
import { geoPointFromSuggestion } from "./LocationPicker.tsx";
import { tripPlaceProximity } from "../pages/TripDetailPage.tsx";
import type { ItineraryItem, PlaceSuggestion } from "@tripplan/domain";

describe("geoPointFromSuggestion", () => {
  it("maps suggestion fields into GeoPoint", () => {
    const suggestion: PlaceSuggestion = {
      placeId: "poi.1",
      label: "Louvre Museum",
      address: "Rue de Rivoli, Paris",
      lat: 48.8606,
      lng: 2.3376,
      confidence: 0.9,
    };
    expect(geoPointFromSuggestion(suggestion)).toEqual({
      placeId: "poi.1",
      label: "Louvre Museum",
      address: "Rue de Rivoli, Paris",
      lat: 48.8606,
      lng: 2.3376,
    });
  });

  it("omits address when absent", () => {
    const suggestion: PlaceSuggestion = {
      placeId: "p",
      label: "X",
      lat: 1,
      lng: 2,
    };
    expect(geoPointFromSuggestion(suggestion)).toEqual({
      placeId: "p",
      label: "X",
      lat: 1,
      lng: 2,
    });
  });
});

describe("tripPlaceProximity", () => {
  it("returns undefined when no geo", () => {
    expect(tripPlaceProximity([])).toBeUndefined();
  });

  it("averages start/end locations", () => {
    const items = [
      {
        itemId: "i1",
        tripId: "t1",
        type: "hotel",
        title: "H",
        details: { propertyName: "H" },
        sortKey: 1,
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        startLocation: { lat: 10, lng: 20, label: "A" },
        endLocation: { lat: 30, lng: 40, label: "B" },
      },
    ] as unknown as readonly ItineraryItem[];
    expect(tripPlaceProximity(items)).toEqual({ lat: 20, lng: 30 });
  });
});
