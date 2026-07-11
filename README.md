# TripPlan

Modern trip planning platform monorepo.

## Stack

- **TypeScript** end-to-end (strict)
- **Web**: React + Vite SPA shell (Tailwind + shadcn/ui planned)
- **API**: Effect-based HTTP on AWS Lambda + API Gateway
- **Infra**: AWS CDK (us-east-1)
- **E2E**: Playwright
- **Package manager**: pnpm workspaces

## Packages

| Package | Path | Responsibility |
|---------|------|----------------|
| `@tripplan/domain` | `packages/domain` | Pure types, schemas, domain logic |
| `@tripplan/api` | `packages/api` | HTTP API, repositories, workers |
| `@tripplan/web` | `packages/web` | SPA frontend |
| `@tripplan/infra` | `packages/infra` | AWS CDK stacks |
| `@tripplan/e2e` | `packages/e2e` | Playwright end-to-end tests |

Shared tooling lives under `tooling/` (`tsconfig`, `eslint-config`). Versioned airport data lives under `data/airports/`.

## Requirements

- Node.js `>= 20`
- pnpm `>= 9`

## Scripts

```bash
pnpm install
pnpm typecheck   # typecheck all packages
pnpm lint        # lint all packages
pnpm test        # run package tests (when present)
```

## Development

### Web (`@tripplan/web`)

Vite + React SPA shell. Runtime config is loaded from `/config.json` (see `packages/web/public/config.json`).

```bash
pnpm --filter @tripplan/web build

# Local dev (optional): proxy /api to a deployed or local HTTP API
# VITE_API_PROXY_TARGET=https://{api-id}.execute-api.us-east-1.amazonaws.com pnpm --filter @tripplan/web dev
```

Production hosting is CloudFront on **plan.ericminassian.com** (WebStack): SPA from S3, `/api/*` to API Gateway, CSP headers. Domain/cert details: [`packages/infra/README.md`](packages/infra/README.md).

#### PWA offline share cache (optional / post-GA)

Production builds register a service worker (`vite-plugin-pwa` + Workbox) so a guest who already opened a shared itinerary can re-open **`/s`** in airplane mode.

| Cached | Not cached |
|--------|------------|
| SPA shell (JS/CSS/HTML), web manifest, icon | Owner-authenticated APIs (`/api/v1/trips/*`, `/me`, share grant CRUD, …) |
| `GET /config.json` (NetworkFirst, **no** network timeout, maxAge **1h**, 1 entry) | All `/api/*` via **NetworkOnly** (including `GET /api/v1/share/trip`) |
| Last trip DTO in `localStorage` (`tripplan:share:lastTrip`, **7-day TTL**) | Map tiles, attachments, share session POST/DELETE |

Share trip JSON is **not** stored in SW Cache Storage. Offline re-open uses the validated app-level snapshot so a slow/revoked network path cannot silently look like a fresh online success. Online **401/403/404/410** on the share trip clear local + any legacy SW trip cache. “Leave share” also invalidates the in-memory boot memo so remounting `/s` does not re-show the left trip.

**Limitations (stretch — not GA-critical):**

- Only the **last-opened** shared trip is kept; opening another share overwrites `localStorage`.
- Offline view is a **snapshot** — no live owner edits, no map basemap, no attachments.
- Opening a **new** `/s#token` while offline still strips the hash; if a previous trip is cached, the banner explains that the new link could not be opened.
- First visit still requires network (SW install + shell + first trip fetch).
- Share session cookies still expire server-side; offline re-open uses the local snapshot, not a renewed cookie.
- “Leave share” clears local + legacy SW trip caches and the boot memo; it cannot wipe another browser/device.
- CloudFront may cache `sw.js` aggressively — the client polls `registration.update()` hourly; prefer short TTL for the SW file in a later ops pass.
- Not a full offline-first editor; owner flows remain online-only.
- PWA install icons are SVG-only (weak Android/iOS install polish).
