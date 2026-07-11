/**
 * API seed helpers for share-session smoke.
 *
 * Uses direct HTTP (Bearer owner JWT) so Playwright does not need passkeys.
 * No dependency on `@tripplan/api` runtime — only public HTTP contracts.
 */

export interface SeededShare {
  readonly tripId: string;
  readonly shareId: string;
  readonly token: string;
  readonly title: string;
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

export class SeedApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "SeedApiError";
    this.status = status;
    this.body = body;
  }
}

function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function ownerFetch(
  baseUrl: string,
  ownerAccessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ownerAccessToken}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(apiUrl(baseUrl, path), {
    ...init,
    headers,
  });
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** UTC civil date YYYY-MM-DD (matches seed timezone: UTC). */
export function civilDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Start today (UTC) through +6 days so the range stays valid if product rejects past trips. */
export function defaultSeedTripDates(now: Date = new Date()): {
  readonly startDate: string;
  readonly endDate: string;
} {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    startDate: civilDateUtc(start),
    endDate: civilDateUtc(end),
  };
}

/**
 * Create trip → optional note → share grant.
 * Returns raw share token once (never persisted by the server).
 */
export async function seedTripWithShare(
  options: SeedShareOptions,
): Promise<SeededShare> {
  const title =
    options.title ??
    `E2E share smoke ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const withNote = options.withNote ?? true;
  const { baseUrl, ownerAccessToken } = options;
  const { startDate, endDate } = defaultSeedTripDates(
    (options.now ?? (() => new Date()))(),
  );

  const createTripRes = await ownerFetch(
    baseUrl,
    ownerAccessToken,
    "/api/v1/trips",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        timezone: "UTC",
        startDate,
        endDate,
      }),
    },
  );
  if (!createTripRes.ok) {
    throw new SeedApiError(
      `Create trip failed (${String(createTripRes.status)})`,
      createTripRes.status,
      await readErrorBody(createTripRes),
    );
  }
  const tripJson = (await createTripRes.json()) as { tripId: string };
  const tripId = tripJson.tripId;

  if (withNote) {
    const noteRes = await ownerFetch(
      baseUrl,
      ownerAccessToken,
      `/api/v1/trips/${encodeURIComponent(tripId)}/items`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "note",
          title: "E2E welcome note",
          notes: "Seeded by @tripplan/e2e share smoke.",
          details: {},
        }),
      },
    );
    if (!noteRes.ok) {
      throw new SeedApiError(
        `Create note failed (${String(noteRes.status)})`,
        noteRes.status,
        await readErrorBody(noteRes),
      );
    }
  }

  const shareRes = await ownerFetch(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/shares`,
    {
      method: "POST",
      body: JSON.stringify({ label: "e2e-smoke" }),
    },
  );
  if (!shareRes.ok) {
    throw new SeedApiError(
      `Create share failed (${String(shareRes.status)})`,
      shareRes.status,
      await readErrorBody(shareRes),
    );
  }
  const shareJson = (await shareRes.json()) as {
    shareId: string;
    token: string;
    path: string;
  };

  const cleanup = async (): Promise<void> => {
    try {
      await ownerFetch(
        baseUrl,
        ownerAccessToken,
        `/api/v1/trips/${encodeURIComponent(tripId)}/shares/${encodeURIComponent(shareJson.shareId)}`,
        { method: "DELETE" },
      );
    } catch {
      // best-effort
    }
    try {
      await ownerFetch(
        baseUrl,
        ownerAccessToken,
        `/api/v1/trips/${encodeURIComponent(tripId)}`,
        { method: "DELETE" },
      );
    } catch {
      // best-effort
    }
  };

  return {
    tripId,
    shareId: shareJson.shareId,
    token: shareJson.token,
    title,
    cleanup,
  };
}

export interface ResolvedShareFixture {
  readonly token: string;
  readonly title: string | undefined;
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
      cleanup: seeded.cleanup,
      source: "owner-seed",
    };
  }
  return undefined;
}
