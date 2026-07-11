/**
 * API seed helpers for e2e critical paths.
 *
 * Uses direct HTTP (Bearer owner JWT) so Playwright does not need passkeys.
 * No dependency on `@tripplan/api` runtime — only public HTTP contracts.
 */

import {
  cleanupTrip,
  createNoteItem,
  createShareGrant,
  createTrip,
} from "./api.js";

export {
  SeedApiError,
  civilDateUtc,
  defaultSeedTripDates,
  createTrip,
  createNoteItem,
  createShareGrant,
  createFlightItemFromEnrichment,
  enrichFlight,
  exportTripJson,
  listAttachments,
  uploadAttachment,
  cleanupTrip,
} from "./api.js";

/** Default note title when seeding share smoke with owner token. */
export const SEED_NOTE_TITLE = "E2E welcome note" as const;

export interface SeededShare {
  readonly tripId: string;
  readonly shareId: string;
  readonly token: string;
  readonly title: string;
  readonly noteTitle: string | undefined;
  /** Revoke share (and soft-delete trip when we created it). Best-effort. */
  readonly cleanup: () => Promise<void>;
}

export interface SeedShareOptions {
  readonly baseUrl: string;
  readonly ownerAccessToken: string;
  /** Override default e2e title. */
  readonly title?: string;
  /** When true (default), also create a note item so the timeline is non-empty. */
  readonly withNote?: boolean;
  /** Clock for relative civil dates (injectable for tests). */
  readonly now?: () => Date;
}

/**
 * Create trip → optional note → share grant.
 * Returns raw share token once (never persisted by the server).
 */
export async function seedTripWithShare(
  options: SeedShareOptions,
): Promise<SeededShare> {
  const withNote = options.withNote ?? true;
  const { baseUrl, ownerAccessToken } = options;

  const trip = await createTrip(baseUrl, ownerAccessToken, {
    title: options.title,
    now: (options.now ?? (() => new Date()))(),
  });

  let noteTitle: string | undefined;
  if (withNote) {
    const note = await createNoteItem(baseUrl, ownerAccessToken, trip.tripId, {
      title: SEED_NOTE_TITLE,
      notes: "Seeded by @tripplan/e2e share smoke.",
    });
    noteTitle = note.title;
  }

  const share = await createShareGrant(
    baseUrl,
    ownerAccessToken,
    trip.tripId,
    "e2e-smoke",
  );

  const cleanup = async (): Promise<void> => {
    await cleanupTrip(baseUrl, ownerAccessToken, trip.tripId, share.shareId);
  };

  return {
    tripId: trip.tripId,
    shareId: share.shareId,
    token: share.token,
    title: trip.title,
    noteTitle,
    cleanup,
  };
}

export interface ResolvedShareFixture {
  readonly token: string;
  readonly title: string | undefined;
  /** Known when seeded via owner token; assert in share UI. */
  readonly noteTitle: string | undefined;
  readonly cleanup: () => Promise<void>;
  readonly source: "share-token" | "owner-seed";
}

/**
 * Resolve a share capability for the browser test.
 * Prefers `E2E_SHARE_TOKEN` (no passkey / no owner JWT at runtime).
 */
export async function resolveShareFixture(env: {
  readonly baseUrl: string;
  readonly shareToken: string | undefined;
  readonly shareTripTitle: string | undefined;
  readonly ownerAccessToken: string | undefined;
}): Promise<ResolvedShareFixture | undefined> {
  if (env.shareToken !== undefined) {
    return {
      token: env.shareToken,
      title: env.shareTripTitle,
      noteTitle: undefined,
      cleanup: async () => undefined,
      source: "share-token",
    };
  }
  if (env.ownerAccessToken !== undefined) {
    const seeded = await seedTripWithShare({
      baseUrl: env.baseUrl,
      ownerAccessToken: env.ownerAccessToken,
    });
    return {
      token: seeded.token,
      title: seeded.title,
      noteTitle: seeded.noteTitle,
      cleanup: seeded.cleanup,
      source: "owner-seed",
    };
  }
  return undefined;
}
