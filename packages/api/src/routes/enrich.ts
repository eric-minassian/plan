import { EnrichFlightRequest } from "@tripplan/domain";
import { Effect, Either } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import {
  checkEnrichGuards,
  EnrichmentGuards,
  isBillableLiveFailure,
  recordLiveSpendIfNeeded,
} from "../enrichment/guards.js";
import { FlightProviderService } from "../enrichment/flight-provider.js";
import type { AppError } from "../errors/app-error.js";
import { decodeJsonBody } from "../http/decode.js";
import { RequestContext } from "../http/request-context.js";
import { jsonResponse, type HttpResponse } from "../http/types.js";

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
    yield* checkEnrichGuards(guards, principal.sub, isLive);

    const outcome = yield* Effect.either(provider.lookup(decoded.right));
    if (Either.isRight(outcome)) {
      recordLiveSpendIfNeeded(guards, isLive, true);
      return jsonResponse(200, outcome.right);
    }

    recordLiveSpendIfNeeded(
      guards,
      isLive,
      isBillableLiveFailure(outcome.left),
    );
    return yield* Effect.fail(outcome.left);
  });
}
