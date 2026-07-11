import { Schema as S } from "effect";
import { Instant } from "./instant.js";

export const ShareGrant = S.Struct({
  shareId: S.String,
  tripId: S.String,
  tokenHash: S.String,
  expiresAt: Instant,
  revoked: S.Boolean,
  label: S.String,
});
export type ShareGrant = typeof ShareGrant.Type;

export const CreateShareGrant = S.Struct({
  /** Optional; server defaults to now + 30 days when omitted. */
  expiresAt: S.optional(Instant),
  label: S.optional(S.String),
});
export type CreateShareGrant = typeof CreateShareGrant.Type;
