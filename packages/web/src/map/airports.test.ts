import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAirportsIndex,
  loadAirportsIndex,
  normalizeIata,
  parseAirportsDataset,
  resetAirportsIndexCache,
} from "./airports.ts";

afterEach(() => {
  resetAirportsIndexCache();
});

describe("normalizeIata", () => {
  it("uppercases and accepts 3-letter codes", () => {
    expect(normalizeIata(" nrt ")).toBe("NRT");
  });

  it("rejects invalid codes", () => {
    expect(normalizeIata("NR")).toBeUndefined();
    expect(normalizeIata("NRTX")).toBeUndefined();
    expect(normalizeIata("12A")).toBeUndefined();
  });
});

describe("parseAirportsDataset", () => {
  it("parses valid rows and skips junk", () => {
    const rows = parseAirportsDataset([
      { iata: "sfo", lat: 37.62, lng: -122.38, name: "SFO" },
      { iata: "XX", lat: 1, lng: 1 },
      { not: "an airport" },
      null,
    ]);
    expect(rows).toEqual([
      {
        iata: "SFO",
        lat: 37.62,
        lng: -122.38,
        name: "SFO",
        timezone: undefined,
      },
    ]);
  });

  it("returns empty for non-array", () => {
    expect(parseAirportsDataset({ iata: "SFO" })).toEqual([]);
  });
});

describe("createAirportsIndex", () => {
  it("looks up by case-insensitive IATA", () => {
    const index = createAirportsIndex([
      { iata: "NRT", lat: 35.76, lng: 140.39, name: "Narita" },
    ]);
    expect(index.size).toBe(1);
    expect(index.get("nrt")?.name).toBe("Narita");
    expect(index.get("LAX")).toBeUndefined();
  });
});

describe("loadAirportsIndex", () => {
  it("caches successful loads", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ iata: "SFO", lat: 1, lng: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const a = await loadAirportsIndex(fetchImpl);
    const b = await loadAirportsIndex(fetchImpl);
    expect(a.get("SFO")?.lat).toBe(1);
    expect(b.get("SFO")?.lat).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures so a later call can retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ iata: "NRT", lat: 3, lng: 4 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(loadAirportsIndex(fetchImpl)).rejects.toThrow(/404/);
    const index = await loadAirportsIndex(fetchImpl);
    expect(index.get("NRT")?.lat).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
