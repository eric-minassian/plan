import { Either, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
  EnrichFlightRequest,
  EnrichPlaceRequest,
  FlightEnrichmentResponse,
  PlaceEnrichmentResponse,
  normalizeFlightNumber,
  parseFlightDesignator,
} from "./enrichment.js";

describe("normalizeFlightNumber / parseFlightDesignator", () => {
  it("normalizes spaces and case", () => {
    expect(normalizeFlightNumber("ua 100")).toBe("UA100");
    expect(normalizeFlightNumber("UA-100")).toBe("UA100");
  });

  it("splits airline code from number", () => {
    expect(parseFlightDesignator("UA100")).toEqual({
      airlineCode: "UA",
      number: "100",
      normalized: "UA100",
    });
    expect(parseFlightDesignator("100")).toEqual({
      airlineCode: undefined,
      number: "100",
      normalized: "100",
    });
  });
});

describe("EnrichFlightRequest schema", () => {
  it("accepts valid request", () => {
    const decoded = S.decodeUnknownEither(EnrichFlightRequest)({
      flightNumber: "UA100",
      date: "2026-07-11",
      departureAirportHint: "sfo",
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("rejects bad date and empty flight number", () => {
    const badDate = S.decodeUnknownEither(EnrichFlightRequest)({
      flightNumber: "UA100",
      date: "2026-13-40",
    });
    expect(Either.isLeft(badDate)).toBe(true);

    const empty = S.decodeUnknownEither(EnrichFlightRequest)({
      flightNumber: "",
      date: "2026-07-11",
    });
    expect(Either.isLeft(empty)).toBe(true);
  });
});

describe("FlightEnrichmentResponse schema", () => {
  it("accepts not_found success DTO", () => {
    const decoded = S.decodeUnknownEither(FlightEnrichmentResponse)({
      status: "not_found",
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("accepts found suggestion", () => {
    const decoded = S.decodeUnknownEither(FlightEnrichmentResponse)({
      status: "found",
      airlineCode: "UA",
      airlineName: "United Airlines",
      flightNumber: "100",
      departure: {
        airportIata: "SFO",
        airportName: "San Francisco International Airport",
        scheduledAt: "2026-07-11T08:00:00-07:00",
        lat: 37.6213,
        lng: -122.379,
        timezone: "America/Los_Angeles",
      },
      arrival: {
        airportIata: "JFK",
        scheduledAt: "2026-07-11T16:30:00-04:00",
        lat: 40.6413,
        lng: -73.7781,
        timezone: "America/New_York",
      },
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
      confidence: 0.95,
    });
    expect(Either.isRight(decoded)).toBe(true);
  });
});

describe("EnrichPlaceRequest schema", () => {
  it("accepts query-only and full request", () => {
    const basic = S.decodeUnknownEither(EnrichPlaceRequest)({
      query: "Hotel de Crillon",
    });
    expect(Either.isRight(basic)).toBe(true);

    const full = S.decodeUnknownEither(EnrichPlaceRequest)({
      query: "Louvre",
      proximity: { lat: 48.8566, lng: 2.3522 },
      limit: 5,
      language: "en",
    });
    expect(Either.isRight(full)).toBe(true);
  });

  it("rejects empty query and out-of-range limit", () => {
    const empty = S.decodeUnknownEither(EnrichPlaceRequest)({ query: "" });
    expect(Either.isLeft(empty)).toBe(true);

    const badLimit = S.decodeUnknownEither(EnrichPlaceRequest)({
      query: "Paris",
      limit: 20,
    });
    expect(Either.isLeft(badLimit)).toBe(true);
  });

  it("rejects whitespace-only query and trims valid query", () => {
    const blank = S.decodeUnknownEither(EnrichPlaceRequest)({ query: "   " });
    expect(Either.isLeft(blank)).toBe(true);

    const trimmed = S.decodeUnknownEither(EnrichPlaceRequest)({
      query: "  Louvre  ",
    });
    expect(Either.isRight(trimmed)).toBe(true);
    if (Either.isRight(trimmed)) {
      expect(trimmed.right.query).toBe("Louvre");
    }
  });
});

describe("PlaceEnrichmentResponse schema", () => {
  it("accepts found with results and not_found with empty results", () => {
    const found = S.decodeUnknownEither(PlaceEnrichmentResponse)({
      status: "found",
      results: [
        {
          placeId: "poi.1",
          label: "Louvre Museum",
          address: "Rue de Rivoli, Paris, France",
          lat: 48.8606,
          lng: 2.3376,
          types: ["poi"],
          confidence: 0.98,
        },
      ],
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
    expect(Either.isRight(found)).toBe(true);

    const notFound = S.decodeUnknownEither(PlaceEnrichmentResponse)({
      status: "not_found",
      results: [],
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
    expect(Either.isRight(notFound)).toBe(true);
  });
});
