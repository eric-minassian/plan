import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { normalizeInstant } from "@tripplan/domain";
import { makeMockPlaceProvider } from "./mock-place-provider.js";

const fixedClock = () => normalizeInstant("2026-07-11T12:00:00Z");

describe("MockPlaceProvider", () => {
  const provider = makeMockPlaceProvider(fixedClock);

  it("is not live and named mock", () => {
    expect(provider.isLive).toBe(false);
    expect(provider.name).toBe("mock");
  });

  it("returns Paris hotels for hotel paris", async () => {
    const result = await Effect.runPromise(
      provider.search({ query: "hotel paris" }),
    );
    expect(result.status).toBe("found");
    expect(result.provider).toBe("mock");
    expect(result.fetchedAt).toBe("2026-07-11T12:00:00Z");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]?.label.toLowerCase()).toContain("ritz");
  });

  it("returns Louvre for louvre query", async () => {
    const result = await Effect.runPromise(
      provider.search({ query: "Louvre museum" }),
    );
    expect(result.status).toBe("found");
    expect(result.results[0]?.label).toContain("Louvre");
    expect(result.results[0]?.lat).toBeCloseTo(48.8606, 3);
  });

  it("returns not_found for notfound fixture", async () => {
    const result = await Effect.runPromise(
      provider.search({ query: "notfound" }),
    );
    expect(result).toEqual({
      status: "not_found",
      results: [],
      provider: "mock",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
  });

  it("respects limit", async () => {
    const result = await Effect.runPromise(
      provider.search({ query: "hotel paris", limit: 1 }),
    );
    expect(result.results).toHaveLength(1);
  });

  it("returns synthetic hit for unknown queries", async () => {
    const result = await Effect.runPromise(
      provider.search({ query: "some cafe" }),
    );
    expect(result.status).toBe("found");
    expect(result.results[0]?.label.toLowerCase()).toContain("some");
  });
});
