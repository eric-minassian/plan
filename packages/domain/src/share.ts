import { Schema as S } from "effect";
import { AttachmentMeta } from "./attachment.js";
import { Instant } from "./instant.js";
import { ItineraryItem } from "./itinerary-item.js";
import { CivilDate, IanaTimeZone } from "./trip.js";

/** SPA path that hosts the hash-fragment share exchange. */
export const SHARE_PATH = "/s" as const;

/** HttpOnly cookie name for the share session (first-party on plan host). */
export const SHARE_COOKIE_NAME = "tripplan_share" as const;

/** Share session lifetime (design). Revoke is immediate via grant revalidation. */
export const SHARE_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Default grant lifetime when client omits `expiresAt`. */
export const SHARE_DEFAULT_EXPIRY_DAYS = 30;

/** Maximum grant lifetime from create time. */
export const SHARE_MAX_EXPIRY_DAYS = 365;

/** Max length for optional share label. */
export const SHARE_LABEL_MAX_LENGTH = 80;

/** Public share-session exchange rate limit (attempts per IP per hour). */
export const SHARE_SESSION_RATE_LIMIT_PER_HOUR = 20;

/**
 * Max active (non-revoked) share grants per trip.
 * Mirrors other hard quotas (trips/items) for dogfood abuse bounds.
 */
export const MAX_ACTIVE_SHARES_PER_TRIP = 25;

/** Max length for CreateShareSession.token (real tokens ~43 base64url chars). */
export const SHARE_TOKEN_MAX_LENGTH = 128;

/** Public fallback when owner profile display name is unavailable. Never use ownerId. */
export const SHARE_OWNER_DISPLAY_FALLBACK = "Trip owner" as const;

/** Stored share grant (tokenHash only — raw token never persisted). */
export const ShareGrant = S.Struct({
  shareId: S.String,
  tripId: S.String,
  ownerId: S.String,
  tokenHash: S.String,
  expiresAt: Instant,
  revoked: S.Boolean,
  label: S.String,
});
export type ShareGrant = typeof ShareGrant.Type;

/** Owner list view — no token or tokenHash. */
export const ShareGrantPublic = S.Struct({
  shareId: S.String,
  tripId: S.String,
  expiresAt: Instant,
  revoked: S.Boolean,
  label: S.String,
});
export type ShareGrantPublic = typeof ShareGrantPublic.Type;

export const CreateShareGrant = S.Struct({
  /** Optional; server defaults to now + 30 days when omitted. */
  expiresAt: S.optional(Instant),
  label: S.optional(
    S.String.pipe(S.maxLength(SHARE_LABEL_MAX_LENGTH)),
  ),
});
export type CreateShareGrant = typeof CreateShareGrant.Type;

/**
 * Create response. `token` is the raw capability secret returned **once**.
 * Client builds `url = origin + path + "#" + token` — server never returns a full URL.
 */
export const CreateShareResponse = S.Struct({
  shareId: S.String,
  token: S.String,
  path: S.Literal(SHARE_PATH),
  expiresAt: Instant,
  label: S.String,
});
export type CreateShareResponse = typeof CreateShareResponse.Type;

export const ShareListResponse = S.Struct({
  shares: S.Array(ShareGrantPublic),
});
export type ShareListResponse = typeof ShareListResponse.Type;

export const CreateShareSession = S.Struct({
  token: S.String.pipe(
    S.minLength(1),
    S.maxLength(SHARE_TOKEN_MAX_LENGTH),
  ),
});
export type CreateShareSession = typeof CreateShareSession.Type;

/**
 * Read-only trip for share viewers.
 * Exposes `ownerDisplayName` only — never ownerId (use generic fallback if unknown).
 * `attachments` is ready-only metadata (no s3Key); pending uploads are omitted.
 */
export const ShareTripDTO = S.Struct({
  tripId: S.String,
  title: S.String,
  timezone: IanaTimeZone,
  startDate: CivilDate,
  endDate: CivilDate,
  ownerDisplayName: S.String,
  items: S.Array(ItineraryItem),
  attachments: S.Array(AttachmentMeta),
});
export type ShareTripDTO = typeof ShareTripDTO.Type;

/** Opaque share session record (server-side store). */
export interface ShareSession {
  readonly sessionId: string;
  readonly tripId: string;
  readonly shareId: string;
  /** Absolute Instant when the session expires. */
  readonly exp: string;
}

export function toShareGrantPublic(grant: ShareGrant): ShareGrantPublic {
  return {
    shareId: grant.shareId,
    tripId: grant.tripId,
    expiresAt: grant.expiresAt,
    revoked: grant.revoked,
    label: grant.label,
  };
}
