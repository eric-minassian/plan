import { AuthError, type AuthClient } from "@ericminassian/auth/client";
import type {
  CreateItineraryItem,
  CreateShareGrant,
  CreateShareResponse,
  CreateTrip,
  ItineraryItem,
  ShareListResponse,
  ShareTripDTO,
  Trip,
  UpdateItineraryItem,
} from "@tripplan/domain";
import {
  decodeCreateShareResponse,
  decodeItemResponse,
  decodeShareListResponse,
  decodeShareTripResponse,
  decodeTripDetailResponse,
  decodeTripListResponse,
  decodeTripResponse,
  etagFromVersion,
  type TripDetailResponse,
  type TripListResponse,
} from "./decode.ts";
import { ApiClientError, parseApiErrorBody } from "./errors.ts";

export type { TripDetailResponse, TripListResponse };
export type { CreateShareResponse, ShareListResponse, ShareTripDTO };

/**
 * Thin TripPlan HTTP client.
 *
 * Uses {@link AuthClient.fetchWithAuth} so Authorization is `DPoP <token>` +
 * proof when available, otherwise `Bearer <token>`. Paths are resolved against
 * the SPA origin so DPoP `htu` matches the public URL the API verifies.
 */
export interface TripPlanApi {
  listTrips(options?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<TripListResponse>;
  createTrip(input: CreateTrip): Promise<Trip>;
  getTrip(tripId: string): Promise<TripDetailResponse>;
  createItem(
    tripId: string,
    input: CreateItineraryItem,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ItineraryItem>;
  updateItem(
    tripId: string,
    itemId: string,
    expectedVersion: number,
    input: UpdateItineraryItem,
  ): Promise<ItineraryItem>;
  deleteItem(tripId: string, itemId: string): Promise<void>;
  listShares(tripId: string): Promise<ShareListResponse>;
  createShare(
    tripId: string,
    input?: CreateShareGrant,
  ): Promise<CreateShareResponse>;
  revokeShare(tripId: string, shareId: string): Promise<void>;
}

export interface TripPlanApiOptions {
  /**
   * Called when the session is dead (401 / Unauthorized envelope, or SDK
   * `login_required`). Typically sign-out or re-login.
   */
  readonly onUnauthorized?: () => void | Promise<void>;
}

export function createTripPlanApi(
  auth: AuthClient,
  options: TripPlanApiOptions = {},
): TripPlanApi {
  const request = <T>(
    path: string,
    init: RequestInit,
    decode: (json: unknown, status: number) => T,
  ): Promise<T> => requestJson(auth, path, init, decode, options);

  return {
    listTrips(listOptions = {}) {
      const params = new URLSearchParams();
      if (listOptions.cursor !== undefined && listOptions.cursor.length > 0) {
        params.set("cursor", listOptions.cursor);
      }
      if (listOptions.limit !== undefined) {
        params.set("limit", String(listOptions.limit));
      }
      const query = params.toString();
      const path =
        query.length > 0 ? `/api/v1/trips?${query}` : "/api/v1/trips";
      return request(path, { method: "GET" }, decodeTripListResponse);
    },
    createTrip(input) {
      return request(
        "/api/v1/trips",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        decodeTripResponse,
      );
    },
    getTrip(tripId) {
      return request(
        `/api/v1/trips/${encodeURIComponent(tripId)}`,
        { method: "GET" },
        decodeTripDetailResponse,
      );
    },
    createItem(tripId, input, createOptions = {}) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (
        createOptions.idempotencyKey !== undefined &&
        createOptions.idempotencyKey.length > 0
      ) {
        headers["Idempotency-Key"] = createOptions.idempotencyKey;
      }
      return request(
        `/api/v1/trips/${encodeURIComponent(tripId)}/items`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        },
        decodeItemResponse,
      );
    },
    updateItem(tripId, itemId, expectedVersion, input) {
      return request(
        `/api/v1/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "If-Match": etagFromVersion(expectedVersion),
          },
          body: JSON.stringify(input),
        },
        decodeItemResponse,
      );
    },
    deleteItem(tripId, itemId) {
      return requestEmpty(
        auth,
        `/api/v1/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}`,
        { method: "DELETE" },
        options,
      );
    },
    listShares(tripId) {
      return request(
        `/api/v1/trips/${encodeURIComponent(tripId)}/shares`,
        { method: "GET" },
        decodeShareListResponse,
      );
    },
    createShare(tripId, input = {}) {
      return request(
        `/api/v1/trips/${encodeURIComponent(tripId)}/shares`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        decodeCreateShareResponse,
      );
    },
    revokeShare(tripId, shareId) {
      return requestEmpty(
        auth,
        `/api/v1/trips/${encodeURIComponent(tripId)}/shares/${encodeURIComponent(shareId)}`,
        { method: "DELETE" },
        options,
      );
    },
  };
}

/**
 * Public share API (cookie session; no owner JWT).
 * Uses `credentials: "include"` so the HttpOnly tripplan_share cookie is sent.
 */
export interface SharePublicApi {
  exchangeSession(token: string): Promise<void>;
  clearSession(): Promise<void>;
  getTrip(): Promise<ShareTripDTO>;
}

export function createSharePublicApi(): SharePublicApi {
  return {
    exchangeSession(token) {
      return publicRequestEmpty("/api/v1/share/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    },
    clearSession() {
      return publicRequestEmpty("/api/v1/share/session", {
        method: "DELETE",
      });
    },
    getTrip() {
      return publicRequestJson(
        "/api/v1/share/trip",
        { method: "GET" },
        decodeShareTripResponse,
      );
    },
  };
}

async function publicRequestJson<T>(
  path: string,
  init: RequestInit,
  decode: (json: unknown, status: number) => T,
): Promise<T> {
  const url = apiUrl(path);
  const response = await fetch(url, {
    ...init,
    credentials: "include",
  });
  const text = await response.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(
        response.status,
        undefined,
        `Invalid JSON response (${String(response.status)})`,
      );
    }
  }
  if (!response.ok) {
    throw new ApiClientError(response.status, parseApiErrorBody(json));
  }
  if (json === undefined) {
    throw new ApiClientError(
      response.status,
      undefined,
      "Empty response body",
    );
  }
  return decode(json, response.status);
}

async function publicRequestEmpty(
  path: string,
  init: RequestInit,
): Promise<void> {
  const url = apiUrl(path);
  const response = await fetch(url, {
    ...init,
    credentials: "include",
  });
  if (response.ok) {
    return;
  }
  const text = await response.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(
        response.status,
        undefined,
        `Invalid JSON response (${String(response.status)})`,
      );
    }
  }
  throw new ApiClientError(response.status, parseApiErrorBody(json));
}

/** Resolve SPA-origin absolute URL (exported for tests). */
export function apiUrl(path: string, origin: string = window.location.origin): string {
  return new URL(path, origin).toString();
}

async function requestJson<T>(
  auth: AuthClient,
  path: string,
  init: RequestInit,
  decode: (json: unknown, status: number) => T,
  options: TripPlanApiOptions,
): Promise<T> {
  // Absolute URL so DPoP htu binds to the same origin the resource server sees
  // (CloudFront public host, or localhost in dev).
  const url = apiUrl(path);

  let response: Response;
  try {
    response = await auth.fetchWithAuth(url, init);
  } catch (cause) {
    if (cause instanceof AuthError && cause.code === "login_required") {
      await options.onUnauthorized?.();
      throw new ApiClientError(401, undefined, "Authentication required");
    }
    throw cause;
  }

  const text = await response.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(
        response.status,
        undefined,
        `Invalid JSON response (${String(response.status)})`,
      );
    }
  }

  if (!response.ok) {
    const envelope = parseApiErrorBody(json);
    if (
      response.status === 401 ||
      envelope?.type === "Unauthorized"
    ) {
      await options.onUnauthorized?.();
    }
    throw new ApiClientError(response.status, envelope);
  }

  if (json === undefined) {
    throw new ApiClientError(
      response.status,
      undefined,
      "Empty response body",
    );
  }

  return decode(json, response.status);
}

/** DELETE / 204 No Content (and similar) — no JSON body expected. */
async function requestEmpty(
  auth: AuthClient,
  path: string,
  init: RequestInit,
  options: TripPlanApiOptions,
): Promise<void> {
  const url = apiUrl(path);

  let response: Response;
  try {
    response = await auth.fetchWithAuth(url, init);
  } catch (cause) {
    if (cause instanceof AuthError && cause.code === "login_required") {
      await options.onUnauthorized?.();
      throw new ApiClientError(401, undefined, "Authentication required");
    }
    throw cause;
  }

  if (response.ok) {
    return;
  }

  const text = await response.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(
        response.status,
        undefined,
        `Invalid JSON response (${String(response.status)})`,
      );
    }
  }

  const envelope = parseApiErrorBody(json);
  if (response.status === 401 || envelope?.type === "Unauthorized") {
    await options.onUnauthorized?.();
  }
  throw new ApiClientError(response.status, envelope);
}
