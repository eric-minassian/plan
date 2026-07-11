/**
 * @tripplan/e2e — Playwright critical-path tests.
 *
 * PR 10.1: share link exchange + read-only trip smoke.
 * PR 16: trip create, mock enrich (+ flight confirm), share, upload, export.
 * Specs live under `tests/`; helpers under `src/`.
 */

export {
  DEFAULT_E2E_BASE_URL,
  defaultLocalEnvPath,
  hasAnyE2ECredentials,
  hasCriticalPathCredentials,
  hasShareSmokeCredentials,
  loadE2EEnv,
  loadLocalEnvFile,
  criticalPathSkipReason,
  shareSmokeSkipReason,
  type E2EEnv,
} from "./env.js";
export {
  civilDateUtc,
  cleanupTrip,
  createFlightItemFromEnrichment,
  createNoteItem,
  createShareGrant,
  createTrip,
  defaultSeedTripDates,
  enrichFlight,
  exportTripJson,
  listAttachments,
  SeedApiError,
  uploadAttachment,
} from "./api.js";
export {
  resolveShareFixture,
  seedTripWithShare,
  SEED_NOTE_TITLE,
  type ResolvedShareFixture,
  type SeededShare,
  type SeedShareOptions,
} from "./seed.js";
export {
  assertShareSessionFlow,
  openShareViewerWithToken,
  shareCookieFrom,
  type CookieLike,
  type ShareSessionExpectations,
} from "./share-browser.js";

export const E2E_PACKAGE = "@tripplan/e2e" as const;
