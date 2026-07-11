import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/app-error.js";
import { makeMockFlightProvider } from "./mock-flight-provider.js";
import { normalizeInstant } from "@tripplan/domain";

const fixedClock = () => normalizeInstant("2026-07-11T12:00:00Z");

describe("MockFlightProvider", () => {
  const provider = makeMockFlightProvider(fixedClock);

  it("returns found suggestion for UA100 with airport geo", async () => {
    const result = await Effect.runPromise(
      provider.lookup({ flightNumber: "UA 100", date: "2026-07-15" }),
    );
    expect(result.status).toBe("found");
    if (result.status !== "found" && result.status !== "cancelled") {
      throw new Error("expected found");
    }
    expect(result.provider).toBe("mock");
    expect(result.airlineCode).toBe("UA");
    expect(result.flightNumber).toBe("100");
    expect(result.departure.airportIata).toBe("SFO");
    expect(result.arrival.airportIata).toBe("JFK");
    expect(result.departure.lat).toBeCloseTo(37.6213);
    expect(result.arrival.lng).toBeCloseTo(-73.7781);
    expect(result.fetchedAt).toBe("2026-07-11T12:00:00Z");
  });

  it("returns 200 not_found DTO for unknown flights", async () => {
    const result = await Effect.runPromise(
      provider.lookup({ flightNumber: "XX999", date: "2026-07-15" }),
    );
    expect(result).toEqual({
      status: "not_found",
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
  });

  it("returns cancelled status for CX1", async () => {
    const result = await Effect.runPromise(
      provider.lookup({ flightNumber: "CX1", date: "2026-07-15" }),
    );
    expect(result.status).toBe("cancelled");
  });

  it("fails with AmbiguousEnrichment for AMB1", async () => {
    const failed = await Effect.runPromise(
      provider
        .lookup({ flightNumber: "AMB1", date: "2026-07-15" })
        .pipe(Effect.flip),
    );
    expect(failed).toBeInstanceOf(AppError);
    expect(failed.type).toBe("AmbiguousEnrichment");
  });

  it("respects departureAirportHint for UA100", async () => {
    const miss = await Effect.runPromise(
      provider.lookup({
        flightNumber: "UA100",
        date: "2026-07-15",
        departureAirportHint: "LAX",
      }),
    );
    expect(miss.status).toBe("not_found");

    const hit = await Effect.runPromise(
      provider.lookup({
        flightNumber: "UA100",
        date: "2026-07-15",
        departureAirportHint: "SFO",
      }),
    );
    expect(hit.status).toBe("found");
  });
});
