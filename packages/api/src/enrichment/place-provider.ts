import type {
  EnrichPlaceRequest,
  PlaceEnrichmentResponse,
} from "@tripplan/domain";
import { Context, type Effect } from "effect";
import type { AppError } from "../errors/app-error.js";

/**
 * Pluggable place search. Mock is default; MapTiler is live.
 * Implementations must not write itinerary items — callers suggest, user confirms.
 */
export interface PlaceProvider {
  readonly name: string;
  /**
   * When true, lookups may bill a third-party vendor. Budget is pre-checked
   * before lookup and charged only after a billable attempt (not config errors).
   */
  readonly isLive: boolean;
  search(
    query: EnrichPlaceRequest,
  ): Effect.Effect<PlaceEnrichmentResponse, AppError>;
}

/** Effect service tag for the active PlaceProvider. */
export class PlaceProviderService extends Context.Tag("PlaceProvider")<
  PlaceProviderService,
  PlaceProvider
>() {}
