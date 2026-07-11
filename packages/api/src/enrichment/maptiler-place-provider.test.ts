import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { normalizeInstant } from "@tripplan/domain";
import { AppError } from "../errors/app-error.js";
import {
  makeMapTilerPlaceProvider,
  mapMapTilerBody,
} from "./maptiler-place-provider.js";

const fixedClock = () => normalizeInstant("2026-07-11T12:00:00Z");

const sampleFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      id: "poi.123",
      type: "Feature",
      text: "Louvre Museum",
      place_name: "Louvre Museum, Rue de Rivoli, Paris, France",
      place_type: ["poi"],
      relevance: 0.99,
      center: [2.3376, 48.8606],
      geometry: { type: "Point", coordinates: [2.3376, 48.8606] },
    },
    {
      id: "address.9",
      type: "Feature",
      text: "Rue de Rivoli",
      place_name: "Rue de Rivoli, Paris, France",
      place_type: ["address"],
      relevance: 0.7,
      center: [2.34, 48.86],
    },
  ],
};

describe("mapMapTilerBody", () => {
  it("maps features to place suggestions (lng/lat → lat/lng)", () => {
    const result = mapMapTilerBody(
      sampleFeatureCollection,
      "maptiler",
      fixedClock(),
    );
    expect(result.status).toBe("found");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      placeId: "poi.123",
      label: "Louvre Museum",
      address: "Louvre Museum, Rue de Rivoli, Paris, France",
      lat: 48.8606,
      lng: 2.3376,
      confidence: 0.99,
    });
    expect(result.results[0]?.types).toEqual(["poi"]);
  });

  it("returns not_found for empty features", () => {
    const result = mapMapTilerBody(
      { type: "FeatureCollection", features: [] },
      "maptiler",
      fixedClock(),
    );
    expect(result).toEqual({
      status: "not_found",
      results: [],
      provider: "maptiler",
      fetchedAt: "2026-07-11T12:00:00Z",
    });
  });

  it("skips features without coordinates or id", () => {
    const result = mapMapTilerBody(
      {
        type: "FeatureCollection",
        features: [
          { id: "x", text: "No coords" },
          { text: "No id", center: [1, 2] },
        ],
      },
      "maptiler",
      fixedClock(),
    );
    expect(result.status).toBe("not_found");
  });
});

describe("MapTilerPlaceProvider", () => {
  it("is live and named maptiler", () => {
    const provider = makeMapTilerPlaceProvider({
      getCredentials: () => Effect.succeed({ apiKey: "test-key" }),
    });
    expect(provider.isLive).toBe(true);
    expect(provider.name).toBe("maptiler");
  });

  it("calls MapTiler forward geocoding with key and proximity", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleFeatureCollection), { status: 200 }),
    );
    const provider = makeMapTilerPlaceProvider({
      getCredentials: () => Effect.succeed({ apiKey: "test-key" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: fixedClock,
    });

    const result = await Effect.runPromise(
      provider.search({
        query: "Louvre",
        proximity: { lat: 48.85, lng: 2.35 },
        limit: 3,
        language: "en",
      }),
    );

    expect(result.status).toBe("found");
    expect(result.results[0]?.label).toBe("Louvre Museum");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as
      | readonly [string, RequestInit?]
      | undefined;
    const calledUrl = String(firstCall?.[0] ?? "");
    expect(calledUrl).toContain("api.maptiler.com/geocoding/Louvre.json");
    expect(calledUrl).toContain("key=test-key");
    expect(calledUrl).toContain("limit=3");
    expect(calledUrl).toContain("proximity=2.35%2C48.85");
    expect(calledUrl).toContain("language=en");
  });

  it("returns not_found for empty body", async () => {
    const provider = makeMapTilerPlaceProvider({
      getCredentials: () => Effect.succeed({ apiKey: "k" }),
      fetchImpl: (async () =>
        new Response("", { status: 200 })) as unknown as typeof fetch,
      clock: fixedClock,
    });
    const result = await Effect.runPromise(
      provider.search({ query: "nowhere" }),
    );
    expect(result.status).toBe("not_found");
  });

  it("fails UpstreamUnavailable when credentials rejected", async () => {
    const provider = makeMapTilerPlaceProvider({
      getCredentials: () => Effect.succeed({ apiKey: "bad" }),
      fetchImpl: (async () =>
        new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
      clock: fixedClock,
    });
    const error = await Effect.runPromise(
      Effect.either(provider.search({ query: "Paris" })),
    );
    expect(error._tag).toBe("Left");
    if (error._tag === "Left") {
      expect(error.left.type).toBe("UpstreamUnavailable");
      expect(error.left.message).toMatch(/rejected credentials/i);
    }
  });

  it("fails when credentials not configured", async () => {
    const provider = makeMapTilerPlaceProvider({
      getCredentials: () =>
        Effect.fail(
          AppError.upstreamUnavailable(
            "MapTiler credentials not configured (set MAPTILER_API_KEY or MAPTILER_SECRET_JSON)",
          ),
        ),
      clock: fixedClock,
    });
    const error = await Effect.runPromise(
      Effect.either(provider.search({ query: "Paris" })),
    );
    expect(error._tag).toBe("Left");
    if (error._tag === "Left") {
      expect(error.left.message).toMatch(/not configured/i);
    }
  });
});
