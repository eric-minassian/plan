# @tripplan/e2e

Playwright critical-path tests for TripPlan.

## Coverage

| Suite | Spec | Credentials | What it proves |
|-------|------|-------------|----------------|
| Share smoke | `tests/share-session.spec.ts` | `E2E_SHARE_TOKEN` **or** owner token | Hash → session cookie → read-only viewer → leave |
| Critical path | `tests/critical-path.spec.ts` | **Owner token required** | Create trip → mock enrich UA100 → create flight from suggestion → note + attachment presign (+ pending list; PUT/confirm when possible) → export JSON (Content-Disposition) → share session with items visible → leave |

No real passkeys: seed via **API Bearer token** or a **pre-provisioned share token**.

## Requirements

- Node.js `>= 20`
- pnpm `>= 9`
- Chromium for Playwright (`pnpm --filter @tripplan/e2e playwright:install`)
- A deployed plan host with SPA + `/api/*` on the **same origin** (Secure first-party cookies)

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `E2E_BASE_URL` | No (defaults to staging) | e.g. `https://plan-staging.ericminassian.com` |
| `E2E_SHARE_TOKEN` | Share smoke A | Raw share capability (URL hash secret) |
| `E2E_SHARE_TRIP_TITLE` | Recommended with A | Trip title asserted in the UI |
| `E2E_OWNER_ACCESS_TOKEN` | Critical path; share smoke B | Owner Bearer JWT (non-DPoP) |
| `E2E_REQUIRE_ATTACHMENT_UPLOAD` | No (default false) | Fail if S3 PUT/confirm does not complete |

**Share smoke option A (preferred for CI):** create a long-lived share grant once, put the hash token in `E2E_SHARE_TOKEN`.

**Critical path / share option B:** supply a **non-DPoP-bound** owner access token. Helpers create trip + items + share, then revoke/delete after the test.

Without credentials, suites **skip** (exit 0) so local/CI stays green when secrets are absent.

### Attachment upload soft-skip

Presign is always asserted, then `GET .../attachments` must list the new id (`pending` or `ready`). The subsequent S3 `PUT` runs via **Node `fetch`** (not a browser — CORS does not apply); failures are typically network, signature/header mismatch, or bucket policy. By default the suite **soft-skips** PUT/confirm after proving the pending row and logs a warning. Set `E2E_REQUIRE_ATTACHMENT_UPLOAD=true` on a runner that can reach the docs bucket to require full presign → PUT → confirm.

### Loading variables locally

1. **Export** (always works):

   ```bash
   export E2E_OWNER_ACCESS_TOKEN='…'
   # optional:
   export E2E_BASE_URL=https://plan-staging.ericminassian.com
   ```

2. **`packages/e2e/.env` file** (optional local DX): copy [`.env.example`](./.env.example) → `.env`.  
   `loadE2EEnv()` loads that file when present and **does not override** already-exported variables.

Never commit real `.env` values (gitignored).

## Run against staging

```bash
# from monorepo root
pnpm install
pnpm --filter @tripplan/e2e playwright:install

export E2E_BASE_URL=https://plan-staging.ericminassian.com   # optional; default is staging

# Full critical path (trip + mock enrich + upload + export + share):
export E2E_OWNER_ACCESS_TOKEN='…'   # non-DPoP Bearer

pnpm --filter @tripplan/e2e test:e2e
# or only critical path:
pnpm --filter @tripplan/e2e test:critical
```

Share smoke only (no owner token):

```bash
export E2E_SHARE_TOKEN='…'          # hash fragment only, not the full URL
export E2E_SHARE_TRIP_TITLE='My shared dogfood trip'
pnpm --filter @tripplan/e2e test:share
```

Production dogfood:

```bash
export E2E_BASE_URL=https://plan.ericminassian.com
export E2E_OWNER_ACCESS_TOKEN='…'
pnpm --filter @tripplan/e2e test:e2e
```

### Staging checklist

1. Staging SPA + API deployed (`plan-staging.ericminassian.com` or your CloudFront URL).
2. `ENRICHMENT_FLIGHT_LIVE` **false** (default) so enrich uses mock UA100 fixtures.
3. Owner token issued for dogfood user; **not** DPoP-bound.
4. Docs bucket configured if you want full attachment PUT/confirm (`E2E_REQUIRE_ATTACHMENT_UPLOAD=true`).
5. Run:

   ```bash
   pnpm --filter @tripplan/e2e playwright:install
   export E2E_OWNER_ACCESS_TOKEN='…'
   pnpm --filter @tripplan/e2e test:e2e
   ```

### Scripts

| Script | Command |
|--------|---------|
| Install browser | `pnpm --filter @tripplan/e2e playwright:install` |
| Share smoke only | `pnpm --filter @tripplan/e2e test:share` |
| Critical path only | `pnpm --filter @tripplan/e2e test:critical` |
| All e2e | `pnpm --filter @tripplan/e2e test:e2e` |
| Typecheck | `pnpm --filter @tripplan/e2e typecheck` |
| Lint | `pnpm --filter @tripplan/e2e lint` |

There is **no** package-level `"test"` script, so root `pnpm test` does not invoke Playwright (unit tests only).

## CI

GitHub Actions job **E2E smoke**:

- **Gates before checkout/install** when neither share nor owner token is set (after whitespace trim) — cheap no-op, exit 0.
- **`E2E_BASE_URL` is optional** in CI; when unset, the package defaults to staging.
- Runs `test:e2e` (share smoke + critical path). Critical path self-skips without owner token; share smoke self-skips without share **or** owner token.

Suggested repository secrets:

- `E2E_OWNER_ACCESS_TOKEN` (enables critical path + share seed)
- and/or `E2E_SHARE_TOKEN` (+ optional `E2E_SHARE_TRIP_TITLE`) for share-only
- `E2E_BASE_URL` only if you need a host other than staging

## Layout

```
packages/e2e/
  playwright.config.ts
  vitest.config.ts
  src/env.ts                 # env loading + optional .env + skip helpers
  src/env.test.ts            # unit tests for env / skip gates
  src/api.ts                 # owner HTTP helpers (trip, enrich, flight, upload, export)
  src/seed.ts                # share fixture seed
  src/share-browser.ts       # shared share-session browser assertions
  tests/share-session.spec.ts
  tests/critical-path.spec.ts
```
