import { Schema as S } from "effect";
import { Instant } from "./instant.js";

export const AttachmentStatus = S.Literal("pending", "ready");
export type AttachmentStatus = typeof AttachmentStatus.Type;

export const Attachment = S.Struct({
  attachmentId: S.String,
  tripId: S.String,
  itemId: S.String,
  s3Key: S.String,
  status: AttachmentStatus,
  contentType: S.String,
  sizeBytes: S.Number.pipe(S.nonNegative()),
  fileName: S.String.pipe(S.maxLength(180)),
  /** Pending upload TTL / expiry instant. */
  expiresAt: S.optional(Instant),
  createdAt: Instant,
});
export type Attachment = typeof Attachment.Type;

export const PresignAttachment = S.Struct({
  contentType: S.String,
  fileName: S.String.pipe(S.minLength(1), S.maxLength(180)),
  sizeBytes: S.Number.pipe(S.positive(), S.lessThanOrEqualTo(15 * 1024 * 1024)),
});
export type PresignAttachment = typeof PresignAttachment.Type;
