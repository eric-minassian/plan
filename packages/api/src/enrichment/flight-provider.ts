import type {
  EnrichFlightRequest,
  FlightEnrichmentResponse,
} from "@tripplan/domain";
import { Context, type Effect } from "effect";
import type { AppError } from "../errors/app-error.js";

/**
 * Pluggable flight schedule lookup. Mock is default; AeroDataBox is live.
 * Implementations must not write itinerary items — callers suggest, user confirms.
 */
export interface FlightProvider {
  readonly name: string;
  /**
   * When true, lookups may bill a third-party vendor. Budget is pre-checked
   * before lookup and charged only after a billable attempt (not config errors).
   */
  readonly isLive: boolean;
  lookup(
    query: EnrichFlightRequest,
  ): Effect.Effect<FlightEnrichmentResponse, AppError>;
}

/** Effect service tag for the active FlightProvider. */
export class FlightProviderService extends Context.Tag("FlightProvider")<
  FlightProviderService,
  FlightProvider
>() {}
