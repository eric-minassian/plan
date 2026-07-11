import type {
  EnrichFlightRequest,
  FlightEnrichmentFound,
  FlightEnrichmentResponse,
  Instant,
} from "@tripplan/domain";
import {
  normalizeInstant,
  parseFlightDesignator,
} from "@tripplan/domain";
import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import { airportGeo } from "./airports.js";
import type { FlightProvider } from "./flight-provider.js";
import { nowInstant } from "./now.js";

/**
 * Fixture-based FlightProvider for CI / dogfood (`enrichment.flight.live=false`).
 *
 * Known fixtures:
 * - UA100 / UA 100 → SFO→JFK (found)
 * - AA1 → DFW→JFK (found)
 * - NH9 → HND→SFO (found)
 * - XX999 / NOTFOUND → not_found
 * - AMB1 → AmbiguousEnrichment (422)
 * - CX1 → cancelled
 */
export class MockFlightProvider implements FlightProvider {
  readonly name = "mock";
  readonly isLive = false;

  constructor(private readonly clock: () => Instant = () => nowInstant()) {}

  lookup(
    query: EnrichFlightRequest,
  ): Effect.Effect<FlightEnrichmentResponse, AppError> {
    const designator = parseFlightDesignator(query.flightNumber);
    const key = designator.normalized;
    const fetchedAt = this.clock();
    const providerName = this.name;

    if (key === "AMB1" || key === "AMBIGUOUS1") {
      return Effect.fail(
        AppError.ambiguousEnrichment(
          "Multiple matching flights; refine with departureAirportHint",
          {
            candidates: [
              {
                airlineCode: "UA",
                flightNumber: "1",
                departureAirport: "SFO",
                arrivalAirport: "EWR",
              },
              {
                airlineCode: "UA",
                flightNumber: "1",
                departureAirport: "LAX",
                arrivalAirport: "EWR",
              },
            ],
          },
        ),
      );
    }

    if (
      key === "XX999" ||
      key === "NOTFOUND" ||
      key === "ZZ000" ||
      key.startsWith("NF")
    ) {
      return Effect.succeed({
        status: "not_found",
        provider: providerName,
        fetchedAt,
      });
    }

    if (key === "CX1" || key === "CANCEL1") {
      return Effect.succeed(
        this.buildFound({
          status: "cancelled",
          airlineCode: "CX",
          airlineName: "Cathay Pacific",
          flightNumber: "1",
          depIata: "LHR",
          arrIata: "JFK",
          date: query.date,
          depHour: 11,
          depMinute: 0,
          arrHour: 14,
          arrMinute: 0,
          fetchedAt,
          confidence: 0.9,
        }),
      );
    }

    if (
      key === "UA100" ||
      (designator.airlineCode === "UA" && designator.number === "100")
    ) {
      if (
        query.departureAirportHint !== undefined &&
        query.departureAirportHint.toUpperCase() !== "SFO"
      ) {
        return Effect.succeed({
          status: "not_found",
          provider: providerName,
          fetchedAt,
        });
      }
      return Effect.succeed(
        this.buildFound({
          status: "found",
          airlineCode: "UA",
          airlineName: "United Airlines",
          flightNumber: "100",
          depIata: "SFO",
          arrIata: "JFK",
          date: query.date,
          depHour: 8,
          depMinute: 0,
          arrHour: 16,
          arrMinute: 30,
          depTerminal: "3",
          arrTerminal: "7",
          fetchedAt,
          confidence: 0.95,
        }),
      );
    }

    if (
      key === "AA1" ||
      (designator.airlineCode === "AA" && designator.number === "1")
    ) {
      return Effect.succeed(
        this.buildFound({
          status: "found",
          airlineCode: "AA",
          airlineName: "American Airlines",
          flightNumber: "1",
          depIata: "DFW",
          arrIata: "JFK",
          date: query.date,
          depHour: 9,
          depMinute: 0,
          arrHour: 13,
          arrMinute: 25,
          fetchedAt,
          confidence: 0.9,
        }),
      );
    }

    if (
      key === "NH9" ||
      (designator.airlineCode === "NH" && designator.number === "9")
    ) {
      return Effect.succeed(
        this.buildFound({
          status: "found",
          airlineCode: "NH",
          airlineName: "All Nippon Airways",
          flightNumber: "9",
          depIata: "HND",
          arrIata: "SFO",
          date: query.date,
          depHour: 17,
          depMinute: 30,
          arrHour: 11,
          arrMinute: 0,
          fetchedAt,
          confidence: 0.92,
        }),
      );
    }

    return Effect.succeed({
      status: "not_found",
      provider: providerName,
      fetchedAt,
    });
  }

  private buildFound(input: {
    status: "found" | "cancelled";
    airlineCode: string;
    airlineName: string;
    flightNumber: string;
    depIata: string;
    arrIata: string;
    date: string;
    depHour: number;
    depMinute: number;
    arrHour: number;
    arrMinute: number;
    arrNextDay?: boolean;
    depTerminal?: string;
    arrTerminal?: string;
    fetchedAt: Instant;
    confidence: number;
  }): FlightEnrichmentFound {
    const depGeo = airportGeo(input.depIata);
    const arrGeo = airportGeo(input.arrIata);
    const depTz = depGeo?.timezone ?? "UTC";
    const arrTz = arrGeo?.timezone ?? "UTC";

    const depAt = wallInZoneToInstant(
      input.date,
      input.depHour,
      input.depMinute,
      depTz,
    );
    const arrDate =
      input.arrNextDay === true ? addCivilDays(input.date, 1) : input.date;
    const arrAt = wallInZoneToInstant(
      arrDate,
      input.arrHour,
      input.arrMinute,
      arrTz,
    );

    return {
      status: input.status,
      airlineCode: input.airlineCode,
      airlineName: input.airlineName,
      flightNumber: input.flightNumber,
      departure: {
        airportIata: input.depIata,
        ...(depGeo !== undefined ? { airportName: depGeo.name } : {}),
        scheduledAt: depAt,
        ...(input.depTerminal !== undefined
          ? { terminal: input.depTerminal }
          : {}),
        ...(depGeo !== undefined
          ? { lat: depGeo.lat, lng: depGeo.lng, timezone: depGeo.timezone }
          : {}),
      },
      arrival: {
        airportIata: input.arrIata,
        ...(arrGeo !== undefined ? { airportName: arrGeo.name } : {}),
        scheduledAt: arrAt,
        ...(input.arrTerminal !== undefined
          ? { terminal: input.arrTerminal }
          : {}),
        ...(arrGeo !== undefined
          ? { lat: arrGeo.lat, lng: arrGeo.lng, timezone: arrGeo.timezone }
          : {}),
      },
      provider: this.name,
      fetchedAt: input.fetchedAt,
      confidence: input.confidence,
    };
  }
}

export function makeMockFlightProvider(clock?: () => Instant): FlightProvider {
  return new MockFlightProvider(clock);
}

/** Wall-clock civil time in `timeZone` → domain Instant. */
function wallInZoneToInstant(
  civilDate: string,
  hour: number,
  minute: number,
  timeZone: string,
): Instant {
  const [y, m, d] = civilDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const desiredLocalAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  let utcMs = desiredLocalAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const offset = zoneOffsetMs(utcMs, timeZone);
    utcMs = desiredLocalAsUtc - offset;
  }
  const finalOffset = zoneOffsetMs(utcMs, timeZone);
  const sign = finalOffset >= 0 ? "+" : "-";
  const absMin = Math.abs(Math.round(finalOffset / 60_000));
  const oh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const om = String(absMin % 60).padStart(2, "0");
  const offsetStr = finalOffset === 0 ? "Z" : `${sign}${oh}:${om}`;
  const hh = String(hour).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  return normalizeInstant(`${civilDate}T${hh}:${mi}:00${offsetStr}`);
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    return Number(value);
  };
  const asUtc = Date.UTC(
    num("year"),
    num("month") - 1,
    num("day"),
    num("hour"),
    num("minute"),
    num("second"),
  );
  return asUtc - utcMs;
}

function addCivilDays(civilDate: string, days: number): string {
  const [y, m, d] = civilDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
