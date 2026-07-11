import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeInMemoryEnrichBudget } from "./budget.js";
import {
  isBillableLiveFailure,
  recordLiveSpendIfNeeded,
} from "./guards.js";
import { AppError } from "../errors/app-error.js";
import { makeInMemoryEnrichRateLimiter } from "./rate-limit.js";

describe("EnrichBudget two-phase charge", () => {
  it("ensureAvailable does not record spend", async () => {
    const budget = makeInMemoryEnrichBudget(1);
    await Effect.runPromise(budget.ensureAvailable(0.01));
    expect(budget.spentUsd()).toBe(0);
    budget.recordSpend(0.01);
    expect(budget.spentUsd()).toBe(0.01);
  });

  it("ensureAvailable fails when over monthly cap", async () => {
    const budget = makeInMemoryEnrichBudget(0.02, 0.02);
    const err = await Effect.runPromise(
      budget.ensureAvailable(0.01).pipe(Effect.flip),
    );
    expect(err.type).toBe("UpstreamUnavailable");
    expect(err.message).toMatch(/budget exceeded/i);
  });

  it("credential config failures are not billable", () => {
    expect(
      isBillableLiveFailure(
        AppError.upstreamUnavailable(
          "AeroDataBox credentials not configured (set AERODATABOX_API_KEY)",
        ),
      ),
    ).toBe(false);
    expect(
      isBillableLiveFailure(
        AppError.upstreamUnavailable("AeroDataBox rejected credentials"),
      ),
    ).toBe(true);
    expect(
      isBillableLiveFailure(
        AppError.ambiguousEnrichment("multi", { candidates: [] }),
      ),
    ).toBe(true);
  });

  it("recordLiveSpendIfNeeded respects isLive and billable", () => {
    const budget = makeInMemoryEnrichBudget(10);
    const guards = {
      rateLimiter: makeInMemoryEnrichRateLimiter(60),
      budget,
      liveLookupCostUsd: 0.5,
      livePlaceLookupCostUsd: 0.005,
    };
    recordLiveSpendIfNeeded(guards, false, true);
    expect(budget.spentUsd()).toBe(0);
    recordLiveSpendIfNeeded(guards, true, false);
    expect(budget.spentUsd()).toBe(0);
    recordLiveSpendIfNeeded(guards, true, true);
    expect(budget.spentUsd()).toBe(0.5);
  });
});
