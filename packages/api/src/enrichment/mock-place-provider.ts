import type {
  EnrichPlaceRequest,
  Instant,
  PlaceEnrichmentResponse,
  PlaceSuggestion,
} from "@tripplan/domain";
import { Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import { nowInstant } from "./now.js";
import type { PlaceProvider } from "./place-provider.js";

const DEFAULT_LIMIT = 5;

/**
 * Fixture-based PlaceProvider for CI / dogfood (`enrichment.places.live=false`).
 *
 * Known fixtures (case-insensitive substring):
 * - notfound / zzempty / xx999 → not_found
 * - ritz / crillon / hotel paris → Paris hotel
 * - louvre → museum
 * - sfo / san francisco → SF city
 * - otherwise: single synthetic hit labeled from the query
 */
export class MockPlaceProvider implements PlaceProvider {
  readonly name = "mock";
  readonly isLive = false;

  constructor(private readonly clock: () => Instant = () => nowInstant()) {}

  search(
    query: EnrichPlaceRequest,
  ): Effect.Effect<PlaceEnrichmentResponse, AppError> {
    const fetchedAt = this.clock();
    const providerName = this.name;
    const q = query.query.trim().toLowerCase();
    const limit = query.limit ?? DEFAULT_LIMIT;

    if (
      q.length === 0 ||
      q.includes("notfound") ||
      q.includes("zzempty") ||
      q === "xx999"
    ) {
      return Effect.succeed({
        status: "not_found",
        results: [],
        provider: providerName,
        fetchedAt,
      });
    }

    const pool = matchFixtures(q);
    const results = pool.slice(0, Math.max(1, Math.min(limit, 10)));

    return Effect.succeed({
      status: results.length > 0 ? "found" : "not_found",
      results,
      provider: providerName,
      fetchedAt,
    });
  }
}

export function makeMockPlaceProvider(clock?: () => Instant): PlaceProvider {
  return new MockPlaceProvider(clock);
}

function matchFixtures(q: string): PlaceSuggestion[] {
  if (
    q.includes("ritz") ||
    q.includes("crillon") ||
    q.includes("hotel paris") ||
    (q.includes("hotel") && q.includes("paris"))
  ) {
    return [
      {
        placeId: "mock:hotel.paris.ritz",
        label: "Hôtel Ritz Paris",
        address: "15 Place Vendôme, 75001 Paris, France",
        lat: 48.8682,
        lng: 2.3287,
        types: ["poi", "hotel"],
        confidence: 0.96,
      },
      {
        placeId: "mock:hotel.paris.crillon",
        label: "Hôtel de Crillon",
        address: "10 Place de la Concorde, 75008 Paris, France",
        lat: 48.8674,
        lng: 2.3215,
        types: ["poi", "hotel"],
        confidence: 0.94,
      },
    ];
  }

  if (q.includes("louvre")) {
    return [
      {
        placeId: "mock:poi.louvre",
        label: "Louvre Museum",
        address: "Rue de Rivoli, 75001 Paris, France",
        lat: 48.8606,
        lng: 2.3376,
        types: ["poi", "museum"],
        confidence: 0.98,
      },
    ];
  }

  if (q.includes("sfo") || q.includes("san francisco")) {
    return [
      {
        placeId: "mock:place.san-francisco",
        label: "San Francisco",
        address: "San Francisco, California, United States",
        lat: 37.7749,
        lng: -122.4194,
        types: ["municipality"],
        confidence: 0.95,
      },
      {
        placeId: "mock:poi.sfo-airport",
        label: "San Francisco International Airport",
        address: "San Francisco, CA 94128, United States",
        lat: 37.6213,
        lng: -122.379,
        types: ["poi", "airport"],
        confidence: 0.93,
      },
    ];
  }

  // Generic synthetic hit so typeahead always has something in mock mode.
  const label = q
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return [
    {
      placeId: `mock:synth.${encodeURIComponent(q).slice(0, 48)}`,
      label: label.length > 0 ? label : "Unknown place",
      address: `${label}, Mock City`,
      lat: 40.7128,
      lng: -74.006,
      types: ["place"],
      confidence: 0.5,
    },
  ];
}
