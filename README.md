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
