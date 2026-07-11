import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { Instant, InstantParseError, normalizeInstant } from "./instant.js";

describe("normalizeInstant", () => {
  it("round-trips Date.toISOString() to second-precision Z form", () => {
    const d = new Date("2024-06-15T14:30:45.123Z");
    const iso = d.toISOString();
    expect(iso).toMatch(/\.\d{3}Z$/);

    const canonical = normalizeInstant(iso);
    expect(canonical).toBe("2024-06-15T14:30:45Z");
    expect(S.is(Instant)(canonical)).toBe(true);
    expect(Date.parse(canonical)).toBe(Date.parse("2024-06-15T14:30:45Z"));
  });

  it("accepts Z and ±HH:MM offsets without fractional seconds", () => {
    expect(normalizeInstant("2024-01-01T00:00:00Z")).toBe("2024-01-01T00:00:00Z");
    expect(normalizeInstant("2024-01-01T00:00:00+05:30")).toBe(
      "2024-01-01T00:00:00+05:30",
    );
    expect(normalizeInstant("2024-01-01T12:34:56-08:00")).toBe(
      "2024-01-01T12:34:56-08:00",
    );
  });

  it("truncates fractional seconds while preserving offset (provider-style)", () => {
    expect(normalizeInstant("2024-03-10T09:15:30.999Z")).toBe(
      "2024-03-10T09:15:30Z",
    );
    expect(normalizeInstant("2024-03-10T09:15:30.1+02:00")).toBe(
      "2024-03-10T09:15:30+02:00",
    );
    expect(normalizeInstant("2024-03-10T09:15:30.123456-07:00")).toBe(
      "2024-03-10T09:15:30-07:00",
    );
    // AeroDataBox / airline-style mixed offset with long fractional tail
    expect(normalizeInstant("2024-11-03T22:45:00.0000000-04:00")).toBe(
      "2024-11-03T22:45:00-04:00",
    );
  });

  it("rejects zoneless local datetimes", () => {
    expect(() => normalizeInstant("2024-01-01T12:00:00")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-01-01 12:00:00")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-01-01")).toThrow(InstantParseError);
  });

  it("rejects malformed, lowercase, and incomplete inputs", () => {
    expect(() => normalizeInstant("")).toThrow(InstantParseError);
    expect(() => normalizeInstant("not-a-date")).toThrow(InstantParseError);
    expect(() => normalizeInstant("2024-01-01T12:00:00+0530")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-01-01t12:00:00Z")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-01-01T12:00:00z")).toThrow(
      InstantParseError,
    );
  });

  it("rejects overflow dates and hour 24 (no rollover storage)", () => {
    expect(() => normalizeInstant("2024-02-30T00:00:00Z")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-04-31T00:00:00Z")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-01-01T24:00:00Z")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2024-02-30T12:00:00+05:30")).toThrow(
      InstantParseError,
    );
    expect(() => normalizeInstant("2023-02-29T00:00:00Z")).toThrow(
      InstantParseError,
    );
  });

  it("accepts real leap-day and max valid clock components", () => {
    expect(normalizeInstant("2024-02-29T23:59:59Z")).toBe("2024-02-29T23:59:59Z");
    expect(normalizeInstant("2024-12-31T00:00:00+00:00")).toBe(
      "2024-12-31T00:00:00+00:00",
    );
  });
});

describe("Instant schema", () => {
  it("rejects impossible clock components even when regex-shaped", () => {
    expect(S.is(Instant)("2024-01-01T99:99:99Z")).toBe(false);
    expect(S.is(Instant)("2024-02-30T00:00:00Z")).toBe(false);
    expect(S.is(Instant)("2024-01-01T00:00:00.123Z")).toBe(false);
    expect(S.is(Instant)("2024-01-01T00:00:00Z")).toBe(true);
  });
});
