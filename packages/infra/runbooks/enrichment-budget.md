# Runbook: Enrichment budget exceeded

**Signals:** CloudWatch alarm `tripplan-{stage}-enrichment-budget`; custom metric `TripPlan` / `EnrichmentEstimatedCostUsd` (dimension `Stage`); API responses `502` with `type: UpstreamUnavailable` when app enforces the cap; vendor invoice spike (AeroDataBox / RapidAPI, MapTiler).

**Dashboard:** CloudWatch → `TripPlan-{stage}` → “Enrichment estimated cost”

## Goals

Stop third-party spend without stranding owners — mock / degraded enrich UX is preferred over open spend.

## Immediate actions

1. **Confirm the metric**
   - Alarm threshold (ObservabilityStack): **prod $25/day**, **non-prod $5/day** (sum of `EnrichmentEstimatedCostUsd`).
   - Until enrich routes emit EMF, the metric may be missing (alarm treats missing as **not breaching**). Cross-check vendor dashboards if the app metric is not live yet.

2. **Turn off live providers**
   - Set feature flag / config: `enrichment.flight.live=false` (mock or static airports only).
   - Keep `enrichment.places` on only if MapTiler cost is within free tier; otherwise disable places enrich too.
   - Redeploy or update runtime config depending on how flags are loaded (env / SSM / app config — follow current API package).

3. **Do not silently raise the budget**
   - Raise daily/monthly caps only after vendor review and product sign-off.
   - If a temporary raise is required, update both:
     - App hard cap (so `UpstreamUnavailable` aligns with reality).
     - ObservabilityStack alarm threshold + AWS Budgets monthly limit if account spend is the concern.

4. **Rate limits**
   - Design default: **60 enrich calls / hour / user** (owner JWT required — enrich is **not** public).
   - If a single user is burning budget, lower per-user cap or investigate token misuse.

5. **Secrets**
   - Confirm AeroDataBox / MapTiler secrets are not leaking to clients (server-side only; browser uses MapTiler **tile** key with referrer restriction, not the server geocoding secret).

## Verify recovery

- Live provider calls stop (vendor console / logs show no new billable traffic).
- UI still offers mock / manual entry path.
- Alarm returns to OK after the 24h window rolls or spend drops under threshold.

## Follow-ups

- Wire EMF: on each enrich attempt publish `EnrichmentEstimatedCostUsd` (estimated USD) under namespace `TripPlan`, dimension `Stage`.
- Align monthly **AWS Budgets** (`tripplan-{stage}-monthly-cost`) with expected AWS + note third-party spend is **outside** AWS Budgets (track in vendor portals).
