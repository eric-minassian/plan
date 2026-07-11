import { Either, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { CivilDate, CreateTrip, IanaTimeZone } from "./trip.js";

describe("CivilDate", () => {
  it("accepts real calendar days", () => {
    expect(Either.isRight(S.decodeUnknownEither(CivilDate)("2024-02-29"))).toBe(
      true,
    );
    expect(Either.isRight(S.decodeUnknownEither(CivilDate)("2024-12-31"))).toBe(
      true,
    );
  });

  it("rejects impossible civil dates", () => {
    expect(Either.isLeft(S.decodeUnknownEither(CivilDate)("2024-13-40"))).toBe(
      true,
    );
    expect(Either.isLeft(S.decodeUnknownEither(CivilDate)("2024-02-30"))).toBe(
      true,
    );
    expect(Either.isLeft(S.decodeUnknownEither(CivilDate)("2023-02-29"))).toBe(
      true,
    );
  });
});

describe("IanaTimeZone", () => {
  it("accepts known zones", () => {
    expect(
      Either.isRight(S.decodeUnknownEither(IanaTimeZone)("America/Los_Angeles")),
    ).toBe(true);
    expect(Either.isRight(S.decodeUnknownEither(IanaTimeZone)("UTC"))).toBe(true);
  });

  it("rejects unknown zones", () => {
    expect(Either.isLeft(S.decodeUnknownEither(IanaTimeZone)("Not/A_Zone"))).toBe(
      true,
    );
    expect(Either.isLeft(S.decodeUnknownEither(IanaTimeZone)(""))).toBe(true);
  });
});

describe("CreateTrip", () => {
  it("requires valid timezone and civil dates", () => {
    const ok = S.decodeUnknownEither(CreateTrip)({
      title: "Japan",
      timezone: "Asia/Tokyo",
      startDate: "2024-06-01",
      endDate: "2024-06-10",
    });
    expect(Either.isRight(ok)).toBe(true);

    const badTz = S.decodeUnknownEither(CreateTrip)({
      title: "Japan",
      timezone: "Fake/Zone",
      startDate: "2024-06-01",
      endDate: "2024-06-10",
    });
    expect(Either.isLeft(badTz)).toBe(true);
  });
});
