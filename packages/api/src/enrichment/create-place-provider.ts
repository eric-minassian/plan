import type { ApiConfig } from "../config.js";
import { makeMapTilerPlaceProvider } from "./maptiler-place-provider.js";
import { makeMockPlaceProvider } from "./mock-place-provider.js";
import type { PlaceProvider } from "./place-provider.js";

/**
 * Select PlaceProvider from config flag `enrichment.places.live`
 * (`ENRICHMENT_PLACES_LIVE` env). Default: mock (CI / dogfood).
 */
export function createPlaceProvider(config: ApiConfig): PlaceProvider {
  if (config.enrichmentPlacesLive) {
    return makeMapTilerPlaceProvider();
  }
  return makeMockPlaceProvider();
}
