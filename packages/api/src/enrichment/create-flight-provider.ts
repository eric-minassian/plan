import type { ApiConfig } from "../config.js";
import { makeAeroDataBoxFlightProvider } from "./aerodatabox-flight-provider.js";
import type { FlightProvider } from "./flight-provider.js";
import { makeMockFlightProvider } from "./mock-flight-provider.js";

/**
 * Select FlightProvider from config flag `enrichment.flight.live`
 * (`ENRICHMENT_FLIGHT_LIVE` env). Default: mock.
 */
export function createFlightProvider(config: ApiConfig): FlightProvider {
  if (config.enrichmentFlightLive) {
    return makeAeroDataBoxFlightProvider();
  }
  return makeMockFlightProvider();
}
