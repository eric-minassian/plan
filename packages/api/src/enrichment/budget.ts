import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";

/** Estimated USD charged per live AeroDataBox lookup (configurable). */
export const DEFAULT_LIVE_FLIGHT_LOOKUP_COST_USD = 0.01;

export interface EnrichBudget {
  /**
   * Fail if remaining monthly budget cannot cover `estimatedUsd`.
   * Does **not** record spend — call {@link recordSpend} after a billable attempt.
   */
  readonly ensureAvailable: (
    estimatedUsd: number,
  ) => Effect.Effect<void, AppError>;
  /**
   * Record spend after a billable live attempt (HTTP reached vendor, or
   * success/not_found/ambiguous after a real call). No-op when amount ≤ 0.
   */
  readonly recordSpend: (estimatedUsd: number) => void;
  readonly spentUsd: () => number;
}

/**
 * Simple in-memory monthly $ hard cap. When exceeded → UpstreamUnavailable
 * without calling the provider (design). Charge is two-phase so credential /
 * pre-flight failures do not burn budget.
 */
export function makeInMemoryEnrichBudget(
  monthlyBudgetUsd: number,
  initialSpentUsd = 0,
): EnrichBudget {
  let spent = initialSpentUsd;

  function failIfUnavailable(
    estimatedUsd: number,
  ): Effect.Effect<void, AppError> {
    return Effect.sync(() => {
      if (estimatedUsd <= 0) {
        return { ok: true as const };
      }
      if (monthlyBudgetUsd <= 0) {
        return { ok: false as const, reason: "budget_disabled" as const };
      }
      if (spent + estimatedUsd > monthlyBudgetUsd) {
        return { ok: false as const, reason: "budget_exceeded" as const };
      }
      return { ok: true as const };
    }).pipe(
      Effect.flatMap((result) => {
        if (result.ok) {
          return Effect.void;
        }
        if (result.reason === "budget_disabled") {
          return Effect.fail(
            AppError.upstreamUnavailable(
              "Live enrichment is disabled (monthly budget is 0)",
              { monthlyBudgetUsd, spentUsd: spent },
            ),
          );
        }
        return Effect.fail(
          AppError.upstreamUnavailable(
            "Enrichment monthly budget exceeded",
            {
              monthlyBudgetUsd,
              spentUsd: spent,
              estimatedUsd,
            },
          ),
        );
      }),
    );
  }

  return {
    spentUsd: () => spent,
    ensureAvailable: failIfUnavailable,
    recordSpend(estimatedUsd: number) {
      if (estimatedUsd <= 0) {
        return;
      }
      spent += estimatedUsd;
    },
  };
}
