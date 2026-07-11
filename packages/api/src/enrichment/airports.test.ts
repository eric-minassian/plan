import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AIRPORTS_V1 } from "./airports-dataset.js";
import { lookupAirport } from "./airports.js";

const here = dirname(fileURLToPath(import.meta.url));
// packages/api/src/enrichment → repo root data/airports/v1.json
const jsonPath = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "data",
  "airports",
  "v1.json",
);

describe("airport dataset", () => {
  it("is non-empty with sample IATA codes", () => {
    expect(AIRPORTS_V1.length).toBeGreaterThanOrEqual(4);
    expect(lookupAirport("SFO")?.lat).toBeCloseTo(37.6213);
    expect(lookupAirport("jfk")?.iata).toBe("JFK");
  });

  it("stays in sync with data/airports/v1.json", () => {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toEqual(AIRPORTS_V1);
  });
});
