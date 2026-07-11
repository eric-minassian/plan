# @tripplan/e2e

Playwright critical-path tests for TripPlan.

## PR 10.1 — Share session smoke

Minimal browser smoke that catches **cookie / CSP / session** regressions on the public share path:

1. Open `/s` with capability token injected into the hash (not logged via `page.goto` URL)
2. SPA exchanges token → `POST /api/v1/share/session` (HttpOnly `tripplan_share`)
3. Hash is cleared; `GET /api/v1/share/trip` loads the read-only timeline
4. “Leave share” → `DELETE /share/session` 204 + cookie cleared

No real passkeys: seed via **API Bearer token** or a **pre-provisioned share token**.

## Requirements

- Node.js `>= 20`
- pnpm `>= 9`
- Chromium for Playwright (`pnpm --filter @tripplan/e2e playwright:install`)
- A deployed plan host with SPA + `/api/*` on the **same origin** (Secure first-party cookies)

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `E2E_BASE_URL` | No (defaults to staging) | e.g. `https://plan-staging.ericminassian.com` or `https://plan.ericminassian.com` |
| `E2E_SHARE_TOKEN` | One of A/B | Raw share capability (URL hash secret) |
| `E2E_SHARE_TRIP_TITLE` | Recommended with A | Trip title asserted in the UI |
| `E2E_OWNER_ACCESS_TOKEN` | One of A/B | Owner Bearer JWT to create trip + share |

**Option A (preferred):** create a long-lived share grant in the UI once, put the hash token in `E2E_SHARE_TOKEN`. CI never touches owner auth.

**Option B:** supply a **non-DPoP-bound** owner access token. The helper creates a trip, note, and share grant, then revokes/deletes after the test. DPoP-bound tokens cannot be sent as bare `Bearer` (API verifier mode `auto`).

Without A or B, the suite **skips** (exit 0) so local/CI stays green when secrets are absent.

### Loading variables locally

Playwright does **not** auto-load shell env from nowhere. Two supported options:

1. **Export** (always works):

   ```bash
   export E2E_SHARE_TOKEN='…'
   # optional:
   export E2E_BASE_URL=https://plan-staging.ericminassian.com
   ```

2. **`packages/e2e/.env` file** (optional local DX): copy [`.env.example`](./.env.example) → `.env`.  
   `loadE2EEnv()` loads that file when present and **does not override** already-exported variables.  
   You can still use `set -a; source .env; set +a` if you prefer the shell.

Never commit real `.env` values (gitignored).

## Run against staging

```bash
# from monorepo root
pnpm install
pnpm --filter @tripplan/e2e playwright:install

export E2E_BASE_URL=https://plan-staging.ericminassian.com   # optional; default is staging
# Option A:
export E2E_SHARE_TOKEN='…'          # hash fragment only, not the full URL
export E2E_SHARE_TRIP_TITLE='My shared dogfood trip'
# — or Option B:
# export E2E_OWNER_ACCESS_TOKEN='…'

pnpm --filter @tripplan/e2e test:share
```

Production dogfood:

```bash
export E2E_BASE_URL=https://plan.ericminassian.com
# same token options as staging
pnpm --filter @tripplan/e2e test:share
```

### Scripts

| Script | Command |
|--------|---------|
| Install browser | `pnpm --filter @tripplan/e2e playwright:install` |
| Share smoke only | `pnpm --filter @tripplan/e2e test:share` |
| All e2e | `pnpm --filter @tripplan/e2e test:e2e` |
| Typecheck | `pnpm --filter @tripplan/e2e typecheck` |
| Lint | `pnpm --filter @tripplan/e2e lint` |

There is **no** package-level `"test"` script, so root `pnpm test` does not invoke Playwright (unit tests only).

## CI

GitHub Actions job **E2E share smoke**:

- **Gates before checkout/install** when neither share nor owner token is set (after whitespace trim) — cheap no-op, exit 0.
- **`E2E_BASE_URL` is optional** in CI; when unset, the package defaults to `https://plan-staging.ericminassian.com` (same as local).
- Whitespace-only secrets are treated as unset (same trim rules as `loadE2EEnv`).

Suggested repository secrets:

- `E2E_SHARE_TOKEN` (and optionally `E2E_SHARE_TRIP_TITLE`) **and/or** `E2E_OWNER_ACCESS_TOKEN`
- `E2E_BASE_URL` only if you need a host other than staging

## Layout

```
packages/e2e/
  playwright.config.ts
  src/env.ts          # env loading + optional .env + skip helpers
  src/seed.ts         # owner API seed (trip + share)
  tests/share-session.spec.ts
```
