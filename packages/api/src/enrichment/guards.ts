import { Context, Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import type { EnrichBudget } from "./budget.js";
import type { EnrichRateLimiter } from "./rate-limit.js";

export interface EnrichmentGuardsService {
  readonly rateLimiter: EnrichRateLimiter;
  readonly budget: EnrichBudget;
  /** Estimated USD for the next live provider call (0 for mock). */
  readonly liveLookupCostUsd: number;
}

export class EnrichmentGuards extends Context.Tag("EnrichmentGuards")<
  EnrichmentGuards,
  EnrichmentGuardsService
>() {}

/**
 * Rate-limit always. For live providers, ensure budget headroom without
 * recording spend yet (charge after a billable attempt).
 */
export function checkEnrichGuards(
  guards: EnrichmentGuardsService,
  userId: string,
  isLiveProvider: boolean,
): Effect.Effect<void, AppError> {
  return Effect.gen(function* () {
    yield* guards.rateLimiter.take(userId);
    if (isLiveProvider) {
      yield* guards.budget.ensureAvailable(guards.liveLookupCostUsd);
    }
  });
}

/**
 * True when a live-provider error means we already attempted a billable call
 * (HTTP / parse), so spend should be recorded. Config/credential failures before
 * the vendor request must not burn budget.
 */
export function isBillableLiveFailure(error: AppError): boolean {
  if (error.type === "AmbiguousEnrichment") {
    return true;
  }
  if (error.type !== "UpstreamUnavailable") {
    return false;
  }
  const msg = error.message.toLowerCase();
  if (
    msg.includes("credentials not configured") ||
    msg.includes("not configured") ||
    msg.includes("rejected credentials")
  ) {
    // Rejected credentials: may have hit the network — still billable.
    // "not configured" is local pre-flight only.
    return msg.includes("rejected credentials");
  }
  return true;
}

/** Record live spend after a billable attempt (success or billable failure). */
export function recordLiveSpendIfNeeded(
  guards: EnrichmentGuardsService,
  isLiveProvider: boolean,
  billable: boolean,
): void {
  if (!isLiveProvider || !billable) {
    return;
  }
  guards.budget.recordSpend(guards.liveLookupCostUsd);
}
