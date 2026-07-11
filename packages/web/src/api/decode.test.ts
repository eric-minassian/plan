import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeCreateTrip,
  decodeTripListResponse,
  decodeTripResponse,
} from "./decode.ts";
import { ApiClientError } from "./errors.ts";

const sampleTrip = {
  tripId: "t1",
  ownerId: "u1",
  title: "Lisbon",
  timezone: "Europe/Lisbon",
  startDate: "2026-06-01",
  endDate: "2026-06-07",
  version: 1,
  status: "active",
};

describe("decodeCreateTrip", () => {
  it("accepts valid create payload", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "Europe/Lisbon",
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects invalid IANA timezone", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "Not/A_Zone",
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects invalid civil date", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "UTC",
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("decodeTripListResponse", () => {
  it("requires trips array", () => {
    expect(() => decodeTripListResponse({}, 200)).toThrow(ApiClientError);
    const ok = decodeTripListResponse({ trips: [sampleTrip] }, 200);
    expect(ok.trips).toHaveLength(1);
  });
});

describe("decodeTripResponse", () => {
  it("requires core trip fields", () => {
    expect(() => decodeTripResponse({ title: "x" }, 201)).toThrow(
      ApiClientError,
    );
    expect(decodeTripResponse(sampleTrip, 201).tripId).toBe("t1");
  });
});
