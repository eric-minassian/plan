import { EnrichFlightRequest, EnrichPlaceRequest } from "@tripplan/domain";
import { Effect, Either } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import {
  checkEnrichGuards,
  EnrichmentGuards,
  isBillableLiveFailure,
  recordLiveSpendIfNeeded,
} from "../enrichment/guards.js";
import { FlightProviderService } from "../enrichment/flight-provider.js";
import {
  makePlaceSearchCache,
  type PlaceSearchCache,
} from "../enrichment/place-search-cache.js";
import { PlaceProviderService } from "../enrichment/place-provider.js";
import type { AppError } from "../errors/app-error.js";
import { decodeJsonBody } from "../http/decode.js";
import { RequestContext } from "../http/request-context.js";
import { jsonResponse, type HttpResponse } from "../http/types.js";

/**
 * Process-local place typeahead cache. Hits skip rate limit + budget + vendor.
 * Short TTL blunts keystroke bursts against the shared 60/h enrich cap.
 */
const placeSearchCache: PlaceSearchCache = makePlaceSearchCache();

/**
 * POST /api/v1/enrich/flight — owner JWT only.
 * Suggest-then-confirm: returns enrichment DTO; never writes itinerary items.
 * not_found is HTTP 200 with `{ status: "not_found" }` (not ApiErrorBody).
 *
 * Budget: pre-check headroom for live providers; charge only after a billable
 * attempt (not credential/config pre-flight failures).
 */
export function handleEnrichFlight(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | RequestContext | FlightProviderService | EnrichmentGuards
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const { request } = yield* RequestContext;
    const provider = yield* FlightProviderService;
    const guards = yield* EnrichmentGuards;

    const decoded = decodeJsonBody(EnrichFlightRequest, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    const isLive = provider.isLive;
    const cost = guards.liveLookupCostUsd;
    yield* checkEnrichGuards(guards, principal.sub, isLive, cost);

    const outcome = yield* Effect.either(provider.lookup(decoded.right));
    if (Either.isRight(outcome)) {
      recordLiveSpendIfNeeded(guards, isLive, true, cost);
      return jsonResponse(200, outcome.right);
    }

    recordLiveSpendIfNeeded(
      guards,
      isLive,
      isBillableLiveFailure(outcome.left),
      cost,
    );
    return yield* Effect.fail(outcome.left);
  });
}

/**
 * POST /api/v1/enrich/place — owner JWT only.
 * Suggest-then-confirm typeahead: returns place suggestions; never writes items.
 * not_found is HTTP 200 with `{ status: "not_found", results: [] }`.
 *
 * Live provider is MapTiler only (no Google Places). Rate limit + $ budget
 * share the same guards as flight enrich. Short TTL response cache skips
 * guards/vendor on identical typeahead queries (see place-search-cache).
 */
export function handleEnrichPlace(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | RequestContext | PlaceProviderService | EnrichmentGuards
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const { request } = yield* RequestContext;
    const provider = yield* PlaceProviderService;
    const guards = yield* EnrichmentGuards;

    const decoded = decodeJsonBody(EnrichPlaceRequest, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }

    const body = decoded.right;
    const cached = placeSearchCache.get(body);
    if (cached !== undefined) {
      return jsonResponse(200, cached);
    }

    const isLive = provider.isLive;
    const cost = guards.livePlaceLookupCostUsd;
    yield* checkEnrichGuards(guards, principal.sub, isLive, cost);

    const outcome = yield* Effect.either(provider.search(body));
    if (Either.isRight(outcome)) {
      placeSearchCache.set(body, outcome.right);
      recordLiveSpendIfNeeded(guards, isLive, true, cost);
      return jsonResponse(200, outcome.right);
    }

    recordLiveSpendIfNeeded(
      guards,
      isLive,
      isBillableLiveFailure(outcome.left),
      cost,
    );
    return yield* Effect.fail(outcome.left);
  });
}
