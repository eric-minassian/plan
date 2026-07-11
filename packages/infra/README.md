# @tripplan/infra

AWS CDK (v2) infrastructure for TripPlan. **All stacks deploy to `us-east-1`.**

## Stacks

| Stack | ID pattern | Contents |
|-------|------------|----------|
| **FoundationStack** | `TripPlan-Foundation-{stage}` | CloudWatch log retention defaults; Secrets Manager placeholders (AeroDataBox, MapTiler server key) |
| **DataStack** | `TripPlan-Data-{stage}` | DynamoDB single-table `TripPlan-{stage}` with GSI1–4 + TTL; S3 documents bucket (SSE-S3, CORS, lifecycle); **PITR on prod** |
| **ApiStack** | `TripPlan-Api-{stage}` | Node 22 ARM64 Lambda + HTTP API; routes `GET /api/v1/health` (public), `GET /api/v1/me` (owner JWT in-Lambda); env `TABLE_NAME` / `AUTH_ISSUER` / `AUTH_AUDIENCE` / `STAGE` / `PUBLIC_API_BASE_URL` (prod/staging). **Profile store is still in-memory** until Dynamo `UserRepository` lands — table R/W grant is preparatory. CORS: prod/staging SPA host only; localhost only on dev. |
| **ObservabilityStack** | `TripPlan-Observability-{stage}` | CloudWatch dashboard + alarms (API 5xx rate w/ min volume, Lambda p95 latency, enrichment $ custom metric); **prod-only** AWS Budgets (Project+Stage tag filters); SNS alarm topic; WAFv2 REGIONAL WebACL (rate-based + managed CRS in count) on HTTP API `$default`; runbook paths / absolute links |

**Not in this package yet:** WebStack (CloudFront SPA).  
**Never planned:** Cognito / AuthStack — owner auth is external OIDC ([eric-minassian/auth](https://github.com/eric-minassian/auth)).

## Requirements

- Node.js `>= 20`
- pnpm `>= 9`
- AWS credentials with permissions to synth/deploy (for deploy only)

## Commands

From the monorepo root:

```bash
pnpm install
pnpm --filter @tripplan/infra typecheck
```

From `packages/infra`:

```bash
# Synthesize CloudFormation (default stage=dev)
pnpm synth

# Explicit stage (allowed: dev | staging | prod — anything else fails synth)
pnpm exec cdk synth -c stage=dev

# Prod REQUIRES alertEmail (synth fails without it)
pnpm exec cdk synth -c stage=prod -c alertEmail=ops@example.com

# Optional: absolute runbook links on the CloudWatch dashboard text widgets
pnpm exec cdk synth -c stage=dev \
  -c runbookBaseUrl=https://github.com/org/tripplan/blob/main/packages/infra/runbooks

# Deploy / destroy (all stacks in this app)
pnpm exec cdk deploy --all -c stage=dev
pnpm exec cdk destroy --all -c stage=dev
```

### Prod deploy checklist

1. `-c stage=prod -c alertEmail=…` (required — confirms SNS subscription + budget email).
2. Confirm SNS email subscription in inbox (opt-in link) after first deploy.
3. Billing console: activate cost allocation tags **`Project`** and **`Stage`** so the prod monthly budget filter works (otherwise tagged filter may under-count).
4. Optional: `-c runbookBaseUrl=https://…/packages/infra/runbooks` so dashboard runbook links are clickable.
5. After traffic: confirm `AWS/ApiGateway` graphs use `ApiId` + `Stage=$default`; WAF panels show Allowed/Blocked.
6. PITR: `aws dynamodb describe-continuous-backups --table-name TripPlan-prod` → `ENABLED` (see [runbooks/delete-dlq.md](./runbooks/delete-dlq.md)).

## Stage behavior

| Stage | PITR | Table deletion protection | Stack termination protection | Removal policy |
|-------|------|---------------------------|------------------------------|----------------|
| `dev` / `staging` | off | off | off | DESTROY (bucket auto-deletes objects) |
| `prod` | **on** | **on** | **on** | RETAIN |

Context: `-c stage=…` (defaults to `dev` in `cdk.json`). Only `dev`, `staging`, and `prod` are accepted.

## Observability

### Dashboard

CloudWatch dashboard name: **`TripPlan-{stage}`**.

Widgets:

- Runbook table (absolute links if `runbookBaseUrl` set; else monospaced repo paths — CloudWatch cannot resolve `./runbooks/…`)
- Metric readiness note (enrichment EMF not live yet; future design signals)
- API Lambda duration (p50/p95/max) with design **1.5s** + alarm **3s** annotations; invocations/errors/throttles
- HTTP API Count / 5xx and Latency p95 (`ApiId` + `Stage=$default`)
- **WAF** Allowed/Blocked (ALL + rate rule) and managed CRS CountedRequests
- Enrichment estimated cost (empty until EMF); Delete DLQ (placeholder until worker)
- Alarm status

### Alarms (SNS topic `tripplan-alarms-{stage}`)

| Alarm | Condition |
|-------|-----------|
| `tripplan-{stage}-api-5xx-rate` | 5xx/Count > **1%** for 10m **only when Count ≥ 20** per 5m period |
| `tripplan-{stage}-api-p95-latency` | Lambda Duration **p95 > 3000ms** for 10m (design target 1.5s is annotation-only) |
| `tripplan-{stage}-enrichment-budget` | `TripPlan/EnrichmentEstimatedCostUsd` sum > **$25/day prod**, **$5/day** else — **not live until EMF** |
| `tripplan-{stage}-delete-dlq-depth` | DLQ visible messages > 0 (**only if** `deleteDlq` wired) |

- **Prod:** `alertEmail` is **required** at synth; ALARM + OK actions on 5xx/latency.
- **Non-prod:** `alertEmail` optional; ALARM only (no OK actions) to cut noise.
- Confirm the SNS email subscription after first deploy or pages go nowhere.

### AWS Budgets

**Prod only** — budget `tripplan-prod-monthly-cost` at **$100/month**.

- **CostFilters:** `TagKeyValue` = `user:Project$TripPlan` and `user:Stage$prod` (AND). Activate these as **Cost Allocation Tags** in Billing or the filter under-counts.
- Dev/staging intentionally have **no** monthly AWS Budget (avoids account-wide false positives when multiple stages share an account).
- With `alertEmail`: notify at 80% actual and 100% forecasted.
- Third-party enrich spend (AeroDataBox, MapTiler) is **outside** AWS Budgets — see [runbooks/enrichment-budget.md](./runbooks/enrichment-budget.md).

### WAF

REGIONAL WebACL `tripplan-{stage}-api`:

- Default allow
- **AWSManagedRulesCommonRuleSet** — **count** mode (observe before block)
- Rate-based rule: **2000 requests / 5 minutes / IP** (`evaluationWindowSec: 300`) → block — **not** a substitute for app share/enrich limits
- Associated to HTTP API stage `$default`
- Export: `WebAclArn` for optional CloudFront attach later (CF needs a separate CLOUDFRONT-scoped ACL)

### Runbooks

| Runbook | Path |
|---------|------|
| Share abuse | [runbooks/share-abuse.md](./runbooks/share-abuse.md) |
| Enrichment budget | [runbooks/enrichment-budget.md](./runbooks/enrichment-budget.md) |
| Delete DLQ (+ PITR verify) | [runbooks/delete-dlq.md](./runbooks/delete-dlq.md) |

Dashboard: pass `-c runbookBaseUrl=…/packages/infra/runbooks` for clickable links.

### Custom metrics (app)

Namespace **`TripPlan`** (constant `TRIPPLAN_METRIC_NAMESPACE`):

| Metric | Dimensions | When |
|--------|------------|------|
| `EnrichmentEstimatedCostUsd` | `Stage` | **Follow-up:** emit via EMF on enrich attempts (sum = estimated USD). Budget alarm is scaffolding until then. |
| `DeleteDlqDepthPlaceholder` | `Stage` | Dashboard only until real SQS DLQ exists |

**Also not alarmed yet** (need app EMF): enrichment outcome fail rate, share 401/403/410 spikes, upload confirm rate, business counters.

## Outputs

| Output | Description |
|--------|-------------|
| `TableName` / `TableArn` | Single-table DynamoDB |
| `DocumentsBucketName` / `DocumentsBucketArn` | S3 docs bucket |
| `AeroDataBoxSecretArn` / `MapTilerSecretArn` | Secrets Manager ARNs |
| `DefaultLogRetentionDays` | Stage default log retention (exported) |
| `HttpApiUrl` | HTTP API base URL |
| `ApiFunctionName` | API Lambda function name |
| `DashboardName` | CloudWatch dashboard name |
| `AlarmTopicArn` | SNS topic for alarms |
| `WebAclArn` | WAFv2 WebACL ARN |
| `MonthlyBudgetUsd` | Monthly AWS Budgets limit (**prod only**) |

### Secrets (placeholders)

Secrets are created with **generated** `apiKey` values (`generateSecretString`) plus static template fields (e.g. AeroDataBox `host`). That avoids a static `SecretString` in the template that CloudFormation would overwrite on every shape change.

After deploy, **replace** values only via Secrets Manager APIs — never put live keys in CDK source, and avoid changing secret generation props in CDK after ops has filled real credentials:

```bash
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id tripplan/dev/aerodatabox \
  --secret-string '{"apiKey":"…","host":"aerodatabox.p.rapidapi.com"}'

aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id tripplan/dev/maptiler \
  --secret-string '{"apiKey":"…"}'
```

## DynamoDB model (summary)

- **Table:** `TripPlan-{stage}`, on-demand, PK/SK strings, TTL attribute `ttl`
- **GSI1** — Trip by id: `GSI1PK`/`GSI1SK`, INCLUDE `ownerId`, `title`, `timezone`, `startDate`, `endDate`, `version`, `deletedAt`, `status`
- **GSI2** — Share token: `GSI2PK`/`GSI2SK`, INCLUDE `shareId`, `revoked`, `expiresAt`, `tripId`, `ownerId`
- **GSI3** — Sessions by trip: `GSI3PK`/`GSI3SK`, KEYS_ONLY
- **GSI4** — Sessions by share: `GSI4PK`/`GSI4SK`, KEYS_ONLY

### PITR (prod)

Point-in-time recovery is **on for prod only**. Verify:

```bash
aws dynamodb describe-continuous-backups \
  --region us-east-1 \
  --table-name TripPlan-prod \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'
```

See [runbooks/delete-dlq.md](./runbooks/delete-dlq.md) for restore notes.

## S3 documents bucket

- Encryption: SSE-S3
- Block all public access; SSL enforced
- CORS (stage-driven list): `https://plan.ericminassian.com`, `http://localhost:5173` (GET/PUT/HEAD); staging host can be added in `docsCorsOrigins` when available
- Object keys (design / PR14): `trips/{tripId}/items/{itemId}/{attachmentId}` — **no** `pending/` prefix
- Lifecycle:
  - abort incomplete multipart after 7 days
  - expire objects tagged `pending=true` after 1 day (aligns with 24h DDB pending TTL)
- Versioning: off

### Attachment lifecycle contract (PR14)

1. Presign PUT for key `trips/{tripId}/items/{itemId}/{attachmentId}` with signed `x-amz-tagging: pending=true` (and Content-Type / Content-Length).
2. DDB row `status: pending` with TTL ~24h.
3. On confirm: HeadObject checks, set DDB `status: ready`, **clear** the `pending` object tag (so lifecycle will not delete confirmed files).
4. Abandoned uploads: DDB TTL drops metadata; S3 lifecycle deletes tagged objects after 1 day. Trip delete worker still lists `trips/{tripId}/` for cascade safety.

## OIDC client registration (companion — not TripPlan CDK)

Owner auth uses the first-party IdP at `auth.ericminassian.com`. **Register the TripPlan RP in the auth repo**, not in this CDK app:

**Repo:** [eric-minassian/auth](https://github.com/eric-minassian/auth) → `config/clients.json`

```json
{
  "client_id": "plan",
  "client_name": "TripPlan",
  "redirect_uris": [
    "https://plan.ericminassian.com/auth/callback",
    "http://localhost:5173/auth/callback"
  ],
  "post_logout_redirect_uris": [
    "https://plan.ericminassian.com/",
    "http://localhost:5173/"
  ],
  "allowed_origins": [
    "https://plan.ericminassian.com",
    "http://localhost:5173"
  ],
  "scopes": ["openid", "profile", "offline_access"]
}
```

Open a PR against the auth repository when redirect URIs or client settings change. TripPlan API validates tokens with audience `plan` via `@ericminassian/auth/server`.
