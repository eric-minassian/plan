import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors/app-error.js";
import {
  makeAeroDataBoxFlightProvider,
  mapAeroDataBoxBody,
  normalizeStoredFlightNumber,
} from "./aerodatabox-flight-provider.js";
import { normalizeInstant } from "@tripplan/domain";

const fixedClock = () => normalizeInstant("2026-07-11T12:00:00Z");

const sampleFlightRow = {
  number: "UA100",
  status: "Expected",
  airline: { iata: "UA", name: "United Airlines" },
  departure: {
    airport: { iata: "SFO" },
    terminal: "3",
    scheduledTime: { local: "2026-07-15T08:00:00-07:00" },
  },
  arrival: {
    airport: { iata: "JFK" },
    terminal: "7",
    scheduledTime: { local: "2026-07-15T16:30:00-04:00" },
  },
};

describe("normalizeStoredFlightNumber", () => {
  it("strips airline prefix when it matches airline code", () => {
    expect(normalizeStoredFlightNumber("UA100", "UA", "UA100")).toBe("100");
    expect(normalizeStoredFlightNumber("100", "UA", "UA100")).toBe("100");
  });
});

describe("mapAeroDataBoxBody", () => {
  it("maps a found flight and normalizes flight number", async () => {
    const result = await Effect.runPromise(
      mapAeroDataBoxBody(
        [sampleFlightRow],
        { flightNumber: "UA100", date: "2026-07-15" },
        "aerodatabox",
        fixedClock(),
      ),
    );
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }
    expect(result.flightNumber).toBe("100");
    expect(result.airlineCode).toBe("UA");
    expect(result.departure.airportIata).toBe("SFO");
    expect(result.departure.terminal).toBe("3");
    expect(result.arrival.airportIata).toBe("JFK");
  });

  it("returns not_found for empty array", async () => {
    const result = await Effect.runPromise(
      mapAeroDataBoxBody(
        [],
        { flightNumber: "XX999", date: "2026-07-15" },
        "aerodatabox",
        fixedClock(),
      ),
    );
    expect(result.status).toBe("not_found");
  });

  it("returns AmbiguousEnrichment for multiple rows without hint", async () => {
    const err = await Effect.runPromise(
      mapAeroDataBoxBody(
        [
          sampleFlightRow,
          {
            ...sampleFlightRow,
            departure: {
              airport: { iata: "LAX" },
              scheduledTime: { local: "2026-07-15T09:00:00-07:00" },
            },
          },
        ],
        { flightNumber: "UA100", date: "2026-07-15" },
        "aerodatabox",
        fixedClock(),
      ).pipe(Effect.flip),
    );
    expect(err.type).toBe("AmbiguousEnrichment");
  });

  it("filters by departureAirportHint", async () => {
    const result = await Effect.runPromise(
      mapAeroDataBoxBody(
        [
          sampleFlightRow,
          {
            ...sampleFlightRow,
            departure: {
              airport: { iata: "LAX" },
              scheduledTime: { local: "2026-07-15T09:00:00-07:00" },
            },
          },
        ],
        {
          flightNumber: "UA100",
          date: "2026-07-15",
          departureAirportHint: "SFO",
        },
        "aerodatabox",
        fixedClock(),
      ),
    );
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.departure.airportIata).toBe("SFO");
    }
  });
});

describe("AeroDataBoxFlightProvider HTTP", () => {
  it("maps HTTP 204 to not_found (not 502)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = makeAeroDataBoxFlightProvider({
      getCredentials: () =>
        Effect.succeed({
          apiKey: "test-key",
          host: "aerodatabox.p.rapidapi.com",
        }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: fixedClock,
    });
    const result = await Effect.runPromise(
      provider.lookup({ flightNumber: "UA100", date: "2026-07-15" }),
    );
    expect(result).toEqual({
      status: "not_found",
      provider: "aerodatabox",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const firstCall = fetchImpl.mock.calls[0] as unknown as
      | [string, RequestInit?]
      | undefined;
    expect(String(firstCall?.[0])).toContain("dateLocalRole=Departure");
  });

  it("maps empty 200 body to not_found", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    );
    const provider = makeAeroDataBoxFlightProvider({
      getCredentials: () =>
        Effect.succeed({
          apiKey: "test-key",
          host: "aerodatabox.p.rapidapi.com",
        }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: fixedClock,
    });
    const result = await Effect.runPromise(
      provider.lookup({ flightNumber: "UA100", date: "2026-07-15" }),
    );
    expect(result.status).toBe("not_found");
  });

  it("uses dateLocalRole=Departure in request URL", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([sampleFlightRow]), { status: 200 }),
    );
    const provider = makeAeroDataBoxFlightProvider({
      getCredentials: () =>
        Effect.succeed({
          apiKey: "test-key",
          host: "aerodatabox.p.rapidapi.com",
        }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: fixedClock,
    });
    await Effect.runPromise(
      provider.lookup({ flightNumber: "UA100", date: "2026-07-15" }),
    );
    const firstCall = fetchImpl.mock.calls[0] as unknown as
      | [string, RequestInit?]
      | undefined;
    expect(String(firstCall?.[0])).toBe(
      "https://aerodatabox.p.rapidapi.com/flights/number/UA100/2026-07-15?dateLocalRole=Departure",
    );
  });

  it("fails with credentials not configured without fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = makeAeroDataBoxFlightProvider({
      getCredentials: () =>
        Effect.fail(
          AppError.upstreamUnavailable(
            "AeroDataBox credentials not configured (set AERODATABOX_API_KEY or AERODATABOX_SECRET_JSON)",
          ),
        ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: fixedClock,
    });
    const err = await Effect.runPromise(
      provider
        .lookup({ flightNumber: "UA100", date: "2026-07-15" })
        .pipe(Effect.flip),
    );
    expect(err.type).toBe("UpstreamUnavailable");
    expect(err.message).toMatch(/credentials not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks provider as live", () => {
    expect(makeAeroDataBoxFlightProvider().isLive).toBe(true);
  });
});
