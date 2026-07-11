import { Either, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
  EnrichFlightRequest,
  FlightEnrichmentResponse,
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
