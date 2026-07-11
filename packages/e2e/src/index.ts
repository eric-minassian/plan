/**
 * @tripplan/e2e — Playwright critical-path tests.
 *
 * PR 10.1: share link exchange + read-only trip smoke.
 * Specs live under `tests/`; helpers under `src/`.
 */

export {
  DEFAULT_E2E_BASE_URL,
  defaultLocalEnvPath,
  hasShareSmokeCredentials,
  loadE2EEnv,
  loadLocalEnvFile,
  shareSmokeSkipReason,
  type E2EEnv,
} from "./env.js";
export {
  civilDateUtc,
  defaultSeedTripDates,
  resolveShareFixture,
  seedTripWithShare,
  SeedApiError,
  type ResolvedShareFixture,
  type SeededShare,
  type SeedShareOptions,
} from "./seed.js";

export const E2E_PACKAGE = "@tripplan/e2e" as const;
