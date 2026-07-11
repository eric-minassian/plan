# Runbook: Share abuse / scraping

**Signals:** spike in share session `401` / `403` / `410`; unusual attempts/IP; WAF rate-limit blocks; CloudWatch alarm on API errors if abuse fans out.

**Dashboard:** CloudWatch → `TripPlan-{stage}` → panels **WAF — Allowed / Blocked** and **WAF — Managed Common Rule Set**. Rule metric names: `tripplan-{stage}-waf-rate`, `tripplan-{stage}-waf-common`.

## Goals

Stop bulk token guessing / scraping of capability links without breaking legitimate share viewers.

## Primary vs edge controls

| Layer | Limit | Role |
|-------|-------|------|
| **App** (primary) | Share session **20 attempts / hour / IP**; enrich **60 / hour / user** | Correct product abuse controls; path-aware |
| **WAF rate** (coarse) | **2000 req / 5 min / IP** → block | DoS / scrape backstop only — far above app caps |
| **WAF managed** | AWS Common Rule Set in **COUNT** | Observe SQLi/XSS-style hits; flip to block after review |

Do **not** rely on WAF rate alone for share-token guessing — 2000/5m will not catch slow enumeration.

## Immediate actions

1. **Confirm signal vs legitimate revoke**
   - Spike of `410` / `403` after an owner revoked a grant is often expected.
   - Spike of `401` with many distinct tokens or IPs → abuse.
   - Check API logs (JSON): `requestId`, path `/api/v1/share…` or session routes — **never** log raw share tokens.
   - Check dashboard WAF panels for `Blocked (RateLimitByIp)` vs managed **Counted** matches.

2. **Tighten application rate limits** (when share session limits exist)
   - Default design: **20 share-session attempts / hour / IP** (DDB token bucket).
   - Temporarily lower the cap via config / feature flag if available.
   - Prefer IP + path-scoped limits over global API throttling.

3. **Revoke grants**
   - Owner: revoke the share from the trip UI (deletes grant + sessions via GSI4).
   - Ops (emergency): mark grant `revoked=true` and delete session rows for that share (`GSI4PK` by share id). Do not rotate unrelated trips.

4. **WAF**
   - ObservabilityStack provisions a **REGIONAL** WAFv2 WebACL (`tripplan-{stage}-api`) associated to the HTTP API `$default` stage.
   - Rate rule: **2000 req / 5 min / IP** (`evaluationWindowSec: 300`) → block.
   - AWS Managed Common Rule Set: **count mode** — review sampled requests before switching to block.
   - To tighten: lower the rate limit, add a geo / IP set, or (later) path-scoped custom rule for `/api/v1/share*`.
   - CloudFront (WebStack, later): add a **CLOUDFRONT**-scoped ACL in `us-east-1` if edge rate limiting is preferred.

5. **Optional hard block**
   - Disable share feature flag `share.enabled` if product supports it.
   - Block offending IPs in WAF IP set (short TTL; re-evaluate).

## Verify recovery

- Share open for a known good link still works.
- Abuse IPs see `403` from WAF or app rate limit.
- 401/403 rate returns to baseline on the dashboard.

## Follow-ups

- Review token entropy and URL leakage (referrer logs, chat paste).
- Confirm CORS does not allow arbitrary origins on prod (prod SPA host only).
- Document any permanent WAF rule changes back into CDK.
