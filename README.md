# TripPlan

Modern trip planning platform monorepo.

## Stack

- **TypeScript** end-to-end (strict)
- **Web**: React + Vite + Tailwind + shadcn/ui
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

This repository is a greenfield scaffold. Application logic, UI, and infrastructure will land in follow-up PRs.
