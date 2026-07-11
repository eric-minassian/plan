/**
 * Thin owner HTTP client for e2e seeds (Bearer JWT only).
 * No dependency on `@tripplan/api` runtime — public HTTP contracts only.
 */

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

export function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function ownerFetch(
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

export async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function ownerJson<T>(
  baseUrl: string,
  ownerAccessToken: string,
  path: string,
  init: RequestInit = {},
  expectedStatus?: number | readonly number[],
): Promise<T> {
  const response = await ownerFetch(baseUrl, ownerAccessToken, path, init);
  const allowed =
    expectedStatus === undefined
      ? undefined
      : typeof expectedStatus === "number"
        ? [expectedStatus]
        : expectedStatus;
  if (allowed !== undefined && !allowed.includes(response.status)) {
    throw new SeedApiError(
      `${init.method ?? "GET"} ${path} failed (${String(response.status)})`,
      response.status,
      await readErrorBody(response),
    );
  }
  if (allowed === undefined && !response.ok) {
    throw new SeedApiError(
      `${init.method ?? "GET"} ${path} failed (${String(response.status)})`,
      response.status,
      await readErrorBody(response),
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** UTC civil date YYYY-MM-DD (matches seed timezone: UTC). */
export function civilDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Start today (UTC) through +6 days. */
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

export interface CreatedTrip {
  readonly tripId: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
}

interface TripCreateResponse {
  readonly tripId: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
}

export async function createTrip(
  baseUrl: string,
  ownerAccessToken: string,
  options: {
    readonly title?: string;
    readonly now?: Date;
  } = {},
): Promise<CreatedTrip> {
  const requestedTitle =
    options.title ??
    `E2E critical ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const requestedDates = defaultSeedTripDates(options.now ?? new Date());
  const trip = await ownerJson<TripCreateResponse>(
    baseUrl,
    ownerAccessToken,
    "/api/v1/trips",
    {
      method: "POST",
      body: JSON.stringify({
        title: requestedTitle,
        timezone: "UTC",
        startDate: requestedDates.startDate,
        endDate: requestedDates.endDate,
      }),
    },
    201,
  );
  // Prefer server-echoed fields so UI asserts match persisted truth.
  return {
    tripId: trip.tripId,
    title: trip.title,
    startDate: trip.startDate,
    endDate: trip.endDate,
  };
}

export async function createNoteItem(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  options: {
    readonly title?: string;
    readonly notes?: string;
  } = {},
): Promise<{ readonly itemId: string; readonly title: string }> {
  const title = options.title ?? "E2E welcome note";
  const item = await ownerJson<{ itemId: string; title?: string }>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/items`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "note",
        title,
        notes: options.notes ?? "Seeded by @tripplan/e2e critical path.",
        details: {},
      }),
    },
    201,
  );
  return { itemId: item.itemId, title: item.title ?? title };
}

export interface CreateFlightFromEnrichmentInput {
  readonly status: "found" | "cancelled";
  readonly flightNumber: string;
  readonly airlineCode?: string;
  readonly airlineName?: string;
  readonly provider: string;
  readonly fetchedAt: string;
  readonly confidence?: number;
  readonly departure: {
    readonly airportIata: string;
    readonly scheduledAt: string;
    readonly terminal?: string;
  };
  readonly arrival: {
    readonly airportIata: string;
    readonly scheduledAt: string;
    readonly terminal?: string;
  };
}

/**
 * Suggest-then-confirm: create a flight item from a successful enrich DTO.
 */
export async function createFlightItemFromEnrichment(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  enrichment: CreateFlightFromEnrichmentInput,
  options: { readonly title?: string } = {},
): Promise<{ readonly itemId: string; readonly title: string }> {
  const designator =
    enrichment.airlineCode !== undefined
      ? `${enrichment.airlineCode}${enrichment.flightNumber}`
      : enrichment.flightNumber;
  const title =
    options.title ??
    `${designator} ${enrichment.departure.airportIata}→${enrichment.arrival.airportIata}`;

  const item = await ownerJson<{ itemId: string; title?: string }>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/items`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "flight",
        title,
        startAt: enrichment.departure.scheduledAt,
        endAt: enrichment.arrival.scheduledAt,
        details: {
          ...(enrichment.airlineCode !== undefined
            ? { airlineCode: enrichment.airlineCode }
            : {}),
          ...(enrichment.airlineName !== undefined
            ? { airlineName: enrichment.airlineName }
            : {}),
          flightNumber: enrichment.flightNumber,
          departureAirport: enrichment.departure.airportIata,
          arrivalAirport: enrichment.arrival.airportIata,
          ...(enrichment.departure.terminal !== undefined
            ? { departureTerminal: enrichment.departure.terminal }
            : {}),
          ...(enrichment.arrival.terminal !== undefined
            ? { arrivalTerminal: enrichment.arrival.terminal }
            : {}),
        },
        enrichment: {
          provider: enrichment.provider,
          fetchedAt: enrichment.fetchedAt,
          ...(enrichment.confidence !== undefined
            ? { confidence: enrichment.confidence }
            : {}),
        },
      }),
    },
    201,
  );
  return { itemId: item.itemId, title: item.title ?? title };
}

export async function createShareGrant(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  label = "e2e-critical",
): Promise<{ readonly shareId: string; readonly token: string }> {
  const share = await ownerJson<{ shareId: string; token: string }>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/shares`,
    {
      method: "POST",
      body: JSON.stringify({ label }),
    },
    201,
  );
  return { shareId: share.shareId, token: share.token };
}

async function ownerDeleteBestEffort(
  baseUrl: string,
  ownerAccessToken: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    const response = await ownerFetch(baseUrl, ownerAccessToken, path, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      const body = await readErrorBody(response);
      console.warn(
        `[e2e] cleanup ${label} non-2xx: ${String(response.status)} ${body}`,
      );
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[e2e] cleanup ${label} failed: ${message}`);
  }
}

export async function revokeShare(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  shareId: string,
): Promise<void> {
  await ownerDeleteBestEffort(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/shares/${encodeURIComponent(shareId)}`,
    `revoke share ${shareId}`,
  );
}

export async function softDeleteTrip(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
): Promise<void> {
  await ownerDeleteBestEffort(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}`,
    `soft-delete trip ${tripId}`,
  );
}

/** Best-effort revoke share + soft-delete trip (logs non-2xx). */
export async function cleanupTrip(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  shareId?: string,
): Promise<void> {
  if (shareId !== undefined) {
    await revokeShare(baseUrl, ownerAccessToken, tripId, shareId);
  }
  await softDeleteTrip(baseUrl, ownerAccessToken, tripId);
}

export interface FlightEndpointDto {
  readonly airportIata: string;
  readonly scheduledAt: string;
  readonly terminal?: string;
}

export interface FlightEnrichmentDto {
  readonly status: "found" | "cancelled" | "not_found";
  readonly flightNumber?: string;
  readonly airlineCode?: string;
  readonly airlineName?: string;
  readonly provider: string;
  readonly fetchedAt: string;
  readonly confidence?: number;
  readonly departure?: FlightEndpointDto;
  readonly arrival?: FlightEndpointDto;
}

/**
 * POST /api/v1/enrich/flight (owner).
 * Staging default is mock provider (UA100 → found).
 */
export async function enrichFlight(
  baseUrl: string,
  ownerAccessToken: string,
  body: {
    readonly flightNumber: string;
    readonly date: string;
    readonly departureAirportHint?: string;
  },
): Promise<FlightEnrichmentDto> {
  return ownerJson<FlightEnrichmentDto>(
    baseUrl,
    ownerAccessToken,
    "/api/v1/enrich/flight",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    200,
  );
}

export interface TripExportItemDto {
  readonly itemId: string;
  readonly type: string;
  readonly title?: string;
}

export interface TripExportDto {
  readonly tripId: string;
  readonly title: string;
  readonly items: readonly TripExportItemDto[];
}

/** GET /api/v1/trips/:tripId/export */
export async function exportTripJson(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
): Promise<{
  readonly body: TripExportDto;
  readonly contentDisposition: string | null;
}> {
  const response = await ownerFetch(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/export`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new SeedApiError(
      `Export trip failed (${String(response.status)})`,
      response.status,
      await readErrorBody(response),
    );
  }
  const body = (await response.json()) as TripExportDto;
  return {
    body,
    contentDisposition: response.headers.get("content-disposition"),
  };
}

export interface PresignResult {
  readonly attachmentId: string;
  readonly s3Key: string;
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresIn: number;
}

export interface AttachmentMetaDto {
  readonly attachmentId: string;
  readonly status: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export async function listAttachments(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  itemId: string,
): Promise<readonly AttachmentMetaDto[]> {
  const body = await ownerJson<{ attachments: AttachmentMetaDto[] }>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}/attachments`,
    { method: "GET" },
    200,
  );
  return body.attachments;
}

/**
 * Presign → PUT bytes → confirm.
 * Returns whether the full upload completed (confirm → ready).
 * When PUT fails (network, signature, bucket policy), returns
 * `{ completed: false }` after successful presign so callers can soft-skip.
 * (Node fetch — browser CORS is not involved.)
 */
export async function uploadAttachment(
  baseUrl: string,
  ownerAccessToken: string,
  tripId: string,
  itemId: string,
  options: {
    readonly fileName?: string;
    readonly contentType?: string;
    readonly bytes?: Uint8Array;
  } = {},
): Promise<{
  readonly presign: PresignResult;
  readonly completed: boolean;
  readonly meta?: AttachmentMetaDto;
  readonly putStatus?: number;
  readonly putError?: string;
}> {
  const contentType = options.contentType ?? "application/pdf";
  const fileName = options.fileName ?? "e2e-critical.pdf";
  // Minimal valid-ish PDF header so content-type checks pass if inspected.
  const bytes =
    options.bytes ??
    new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    );

  const presign = await ownerJson<PresignResult>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}/attachments/presign`,
    {
      method: "POST",
      body: JSON.stringify({
        contentType,
        fileName,
        sizeBytes: bytes.byteLength,
      }),
    },
    201,
  );

  let putStatus: number | undefined;
  let putError: string | undefined;
  try {
    const putHeaders = new Headers();
    for (const [key, value] of Object.entries(presign.requiredHeaders)) {
      putHeaders.set(key, value);
    }
    // Ensure Content-Type / Content-Length if signer expected them.
    if (!putHeaders.has("Content-Type")) {
      putHeaders.set("Content-Type", contentType);
    }
    if (!putHeaders.has("Content-Length")) {
      putHeaders.set("Content-Length", String(bytes.byteLength));
    }
    const putResponse = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: putHeaders,
      body: bytes,
    });
    putStatus = putResponse.status;
    if (!putResponse.ok) {
      putError = await putResponse.text().catch(() => "");
      return { presign, completed: false, putStatus, putError };
    }
  } catch (cause) {
    putError = cause instanceof Error ? cause.message : String(cause);
    return { presign, completed: false, putStatus, putError };
  }

  const meta = await ownerJson<AttachmentMetaDto>(
    baseUrl,
    ownerAccessToken,
    `/api/v1/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(presign.attachmentId)}/confirm`,
    { method: "POST", body: "{}" },
    [200, 201],
  );

  return { presign, completed: true, meta, putStatus };
}
