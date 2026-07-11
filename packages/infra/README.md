# @tripplan/infra

AWS CDK (v2) infrastructure for TripPlan. **All stacks deploy to `us-east-1`.**

## Stacks

| Stack | ID pattern | Contents |
|-------|------------|----------|
| **FoundationStack** | `TripPlan-Foundation-{stage}` | CloudWatch log retention defaults; Secrets Manager placeholders (AeroDataBox, MapTiler server key) |
| **DataStack** | `TripPlan-Data-{stage}` | DynamoDB single-table `TripPlan-{stage}` with GSI1–4 + TTL; S3 documents bucket (SSE-S3, CORS, lifecycle) |
| **ApiStack** | `TripPlan-Api-{stage}` | Node 22 ARM64 Lambda + HTTP API; trip-delete SQS queue + DLQ (visibility 5m) + cascade worker; CW alarm `tripplan-{stage}-delete-dlq-depth`; env `TABLE_NAME` / `DOCS_BUCKET_NAME` / `TRIP_DELETE_QUEUE_URL` / `AUTH_*` / `STAGE` / `PUBLIC_API_BASE_URL`. Routes: health, me (GET+DELETE stub), trips/shares/items/attachments via proxy. **Profile store is still in-memory** until Dynamo `UserRepository` lands. CORS: prod/staging SPA host only; localhost only on dev. |
| **WebStack** | `TripPlan-Web-{stage}` | Private SPA S3 bucket + CloudFront (OAC); default SPA (403/404 → `/index.html`); `/api/*` → API Gateway HTTP API; CSP response headers; runtime `/config.json`; optional custom domain + Route53 |

**Later:** ObservabilityStack.  
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
pnpm exec cdk synth -c stage=prod

# Deploy / destroy (all stacks in this app)
pnpm exec cdk deploy --all -c stage=dev
pnpm exec cdk destroy --all -c stage=dev
```

## Stage behavior

| Stage | PITR | Table deletion protection | Stack termination protection | Removal policy |
|-------|------|---------------------------|------------------------------|----------------|
| `dev` / `staging` | off | off | off | DESTROY (bucket auto-deletes objects) |
| `prod` | **on** | **on** | **on** | RETAIN |

Context: `-c stage=…` (defaults to `dev` in `cdk.json`). Only `dev`, `staging`, and `prod` are accepted.

## WebStack / CloudFront / domain

Single public host topology: SPA + API under one origin so share cookies stay first-party.

| Path | Origin |
|------|--------|
| `/*` (default) | SPA S3 bucket via Origin Access Control |
| `/config.json` | SPA S3, **cache disabled** (runtime config) |
| `/api/*` | API Gateway HTTP API (`HttpApiUrl` from ApiStack) |

SPA routing: a **CloudFront Function** (viewer-request on the default behavior only) rewrites extension-less paths to `/index.html`. Distribution-level custom error responses are **not** used — they would also rewrite `/api/*` 403/404 into HTML. API status codes pass through unchanged (`GET /api/v1/does-not-exist` must stay JSON 404).

### Domain defaults (stage-aware)

| Stage | Default custom domain |
|-------|------------------------|
| `prod` | `plan.ericminassian.com` |
| `staging` | `plan-staging.ericminassian.com` |
| `dev` | none (CloudFront `*.cloudfront.net` only) |

Override or disable with context:

```bash
# Custom hostname
pnpm exec cdk synth -c stage=prod -c webDomain=plan.ericminassian.com

# Explicitly no custom domain (even on prod)
pnpm exec cdk synth -c stage=prod -c webDomain=
```

### ACM certificate (us-east-1)

CloudFront requires the cert in **us-east-1**. Pass an existing certificate ARN via context so **synth works without a real cert** (no aliases until ARN is set):

```bash
pnpm exec cdk synth -c stage=prod \
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Without `certificateArn`, WebStack still synthesizes and deploys using the default CloudFront domain. If a default/custom `webDomain` is set without a cert, CDK emits a warning and skips aliases.

Create/validate the cert (DNS or email) in ACM **us-east-1** before attaching it — this package does not mint certificates.

### Route53 (optional)

When both zone context keys are present **and** a custom domain + cert are active, WebStack creates A/AAAA aliases:

```bash
pnpm exec cdk deploy --all -c stage=prod \
  -c certificateArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c hostedZoneId=Z0123456789ABC \
  -c hostedZoneName=ericminassian.com
```

If the zone is omitted, point DNS at the `DistributionDomainName` output manually.

### CSP (response headers policy)

Applied to the SPA default behavior:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://*.maptiler.com;
connect-src 'self' https://auth.ericminassian.com https://*.maptiler.com https://<docs-bucket>.s3.us-east-1.amazonaws.com;
worker-src 'self' blob:;
frame-src 'none';
base-uri 'self';
form-action 'self';
```

Docs bucket host is injected from DataStack (`bucketRegionalDomainName`).

### Runtime `config.json`

WebStack deploys `/config.json` to the SPA bucket (BucketDeployment, `prune: false` so CI asset sync is not wiped):

```json
{
  "authIssuer": "https://auth.ericminassian.com",
  "authClientId": "plan",
  "mapTilerApiKey": ""
}
```

Fill `mapTilerApiKey` (referrer-restricted browser key) after deploy (or a post-sync write). SPA static files (`index.html`, assets) are **not** deployed by CDK — build `@tripplan/web` and sync `dist/` to `SpaBucketName`, then invalidate the distribution.

`/config.json` is also served with CloudFront **CACHING_DISABLED** and S3 `Cache-Control: no-cache, must-revalidate` so key rotations are not stuck at the edge.

### Deploy SPA assets

Always **exclude** `config.json` from `s3 sync --delete` so WebStack/ops-managed runtime config (MapTiler browser key) is not overwritten by `public/config.json` from the build:

```bash
pnpm --filter @tripplan/web build

aws s3 sync packages/web/dist "s3://${SPA_BUCKET}/" \
  --delete \
  --exclude config.json \
  --exclude 'config.json/*'

# Optional: set MapTiler key after first deploy (or when rotating)
# aws s3 cp config.prod.json "s3://${SPA_BUCKET}/config.json" \
#   --content-type application/json \
#   --cache-control 'no-cache, must-revalidate'

aws cloudfront create-invalidation \
  --distribution-id "${DIST_ID}" \
  --paths '/*'
```

## Outputs

| Output | Description |
|--------|-------------|
| `TableName` / `TableArn` | Single-table DynamoDB |
| `DocumentsBucketName` / `DocumentsBucketArn` | S3 docs bucket |
| `AeroDataBoxSecretArn` / `MapTilerSecretArn` | Secrets Manager ARNs |
| `DefaultLogRetentionDays` | Stage default log retention (exported) |
| `HttpApiUrl` | HTTP API base URL |
| `ApiFunctionName` | API Lambda function name |
| `SpaBucketName` | SPA static assets bucket |
| `DistributionId` / `DistributionDomainName` | CloudFront distribution |
| `WebUrl` | Public web base URL (custom domain when cert configured) |

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

## S3 documents bucket

- Encryption: SSE-S3
- Block all public access; SSL enforced
- CORS (stage-driven via shared `docsCorsOrigins` in `hosts.ts`, GET/PUT/HEAD):
  - **prod / dev:** `https://plan.ericminassian.com`, `http://localhost:5173`
  - **staging:** `https://plan-staging.ericminassian.com`, prod SPA, Vite local
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

### Trip-delete cascade (PR 15)

- Queue: `tripplan-trip-delete-{stage}` (visibility 5m) → worker Lambda (timeout 4m)
- DLQ: `tripplan-trip-delete-dlq-{stage}`; alarm `tripplan-{stage}-delete-dlq-depth` when visible messages ≥ 1
- API exports `deleteDlq` for ObservabilityStack dashboards
- **Pre-PR15 migrate (dogfood):** see `packages/api/src/workers/migrate-deleted-trips.ts` header — set `TABLE_NAME` + `TRIP_DELETE_QUEUE_URL`, run `listDeletedTripCandidates` + `enqueueCascadeForCandidates`
- **Enqueue failure after DELETE:** trip is already `deleting`; client should retry DELETE (`details.recovery=retry_delete`)

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
