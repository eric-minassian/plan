import { describe, expect, it } from "vitest";
import { normalizeInstant } from "@tripplan/domain";
import {
  makePlaceSearchCache,
  placeCacheKey,
} from "./place-search-cache.js";

describe("placeSearchCache", () => {
  it("keys by normalized query, limit, language, proximity", () => {
    expect(
      placeCacheKey({ query: "  Louvre  ", limit: 5 }),
    ).toBe(placeCacheKey({ query: "louvre", limit: 5 }));
    expect(placeCacheKey({ query: "a", limit: 1 })).not.toBe(
      placeCacheKey({ query: "a", limit: 2 }),
    );
  });

  it("returns hit within TTL and misses after expiry", () => {
    let now = 1_000;
    const cache = makePlaceSearchCache(100, () => now);
    const value = {
      status: "found" as const,
      results: [
        {
          placeId: "p1",
          label: "X",
          lat: 1,
          lng: 2,
        },
      ],
      provider: "mock",
      fetchedAt: normalizeInstant("2026-07-11T12:00:00Z"),
    };
    cache.set({ query: "x" }, value);
    expect(cache.get({ query: "x" })).toEqual(value);
    now = 1_050;
    expect(cache.get({ query: "x" })).toEqual(value);
    now = 1_200;
    expect(cache.get({ query: "x" })).toBeUndefined();
  });
});
