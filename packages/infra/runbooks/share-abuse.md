# Runbook: Share abuse / scraping

**Signals:** spike in share session `401` / `403` / `410`; unusual attempts/IP; WAF rate-limit blocks; CloudWatch alarm on API errors if abuse fans out.

**Dashboard:** CloudWatch → `TripPlan-{stage}` · WAF metrics `tripplan-{stage}-waf-rate`

## Goals

Stop bulk token guessing / scraping of capability links without breaking legitimate share viewers.

## Immediate actions

1. **Confirm signal vs legitimate revoke**
   - Spike of `410` / `403` after an owner revoked a grant is often expected.
   - Spike of `401` with many distinct tokens or IPs → abuse.
   - Check API logs (JSON): `requestId`, path `/api/v1/share…` or session routes — **never** log raw share tokens.

2. **Tighten application rate limits** (when share session limits exist)
   - Default design: **20 share-session attempts / hour / IP** (DDB token bucket).
   - Temporarily lower the cap via config / feature flag if available.
   - Prefer IP + path-scoped limits over global API throttling.

3. **Revoke grants**
   - Owner: revoke the share from the trip UI (deletes grant + sessions via GSI4).
   - Ops (emergency): mark grant `revoked=true` and delete session rows for that share (`GSI4PK` by share id). Do not rotate unrelated trips.

4. **WAF**
   - ObservabilityStack provisions a **REGIONAL** WAFv2 WebACL (`tripplan-{stage}-api`) with a rate-based rule (**2000 req / 5 min / IP**) associated to the HTTP API `$default` stage.
   - To tighten: lower the rate limit on the WebACL rule (console or CDK), or add a geo / custom rule.
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
