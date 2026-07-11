import { describe, expect, it } from "vitest";
import { matchPath } from "./path-match.js";

describe("matchPath", () => {
  it("matches exact paths", () => {
    expect(matchPath("/api/v1/trips", "/api/v1/trips")).toEqual({ params: {} });
  });

  it("captures params", () => {
    expect(matchPath("/api/v1/trips/:tripId", "/api/v1/trips/abc")).toEqual({
      params: { tripId: "abc" },
    });
  });

  it("matches nested export path before bare id patterns when ordered", () => {
    expect(
      matchPath("/api/v1/trips/:tripId/export", "/api/v1/trips/x/export"),
    ).toEqual({ params: { tripId: "x" } });
    expect(
      matchPath("/api/v1/trips/:tripId", "/api/v1/trips/x/export"),
    ).toBeUndefined();
  });

  it("rejects length mismatch", () => {
    expect(matchPath("/api/v1/trips", "/api/v1/trips/extra")).toBeUndefined();
  });
});
