# @tripplan/infra

AWS CDK (v2) infrastructure for TripPlan. **All stacks deploy to `us-east-1`.**

## Stacks (this PR)

| Stack | ID pattern | Contents |
|-------|------------|----------|
| **FoundationStack** | `TripPlan-Foundation-{stage}` | CloudWatch log retention defaults; Secrets Manager placeholders (AeroDataBox, MapTiler server key) |
| **DataStack** | `TripPlan-Data-{stage}` | DynamoDB single-table `TripPlan-{stage}` with GSI1–4 + TTL; S3 documents bucket (SSE-S3, CORS, lifecycle) |
| **ApiStack** | `TripPlan-Api-{stage}` | Node 22 ARM64 Lambda + HTTP API; routes `GET /api/v1/health` (public), `GET /api/v1/me` (owner JWT in-Lambda); env `TABLE_NAME` / `AUTH_ISSUER` / `AUTH_AUDIENCE` / `STAGE` / `PUBLIC_API_BASE_URL` (prod/staging). **Profile store is still in-memory** until Dynamo `UserRepository` lands — table R/W grant is preparatory. CORS: prod/staging SPA host only; localhost only on dev. |
**Not in this package yet:** WebStack, ObservabilityStack.  
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

## Outputs

| Output | Description |
|--------|-------------|
| `TableName` / `TableArn` | Single-table DynamoDB |
| `DocumentsBucketName` / `DocumentsBucketArn` | S3 docs bucket |
| `AeroDataBoxSecretArn` / `MapTilerSecretArn` | Secrets Manager ARNs |
| `DefaultLogRetentionDays` | Stage default log retention (exported) |
| `HttpApiUrl` | HTTP API base URL |
| `ApiFunctionName` | API Lambda function name |

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
