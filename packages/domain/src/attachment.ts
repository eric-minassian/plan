import { Schema as S } from "effect";
import { Instant } from "./instant.js";

/** Hard quota: attachments (pending + ready) per itinerary item. */
export const MAX_ATTACHMENTS_PER_ITEM = 10;

/** Concurrent pending uploads per item (abuse bound). */
export const MAX_PENDING_ATTACHMENTS_PER_ITEM = 5;

/** Max upload size (15 MB). */
export const MAX_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024;

/** DDB pending row TTL / abandoned upload window. */
export const PENDING_ATTACHMENT_TTL_SECONDS = 24 * 60 * 60;

/** Short-lived presigned PUT lifetime. */
export const PRESIGN_PUT_EXPIRES_SECONDS = 15 * 60;

/** Short-lived presigned GET lifetime. */
export const PRESIGN_GET_EXPIRES_SECONDS = 5 * 60;

/** Allowlisted MIME types for document uploads (PDF + common images). */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AllowedAttachmentContentType =
  (typeof ALLOWED_ATTACHMENT_CONTENT_TYPES)[number];

const allowedContentTypeSet: ReadonlySet<string> = new Set(
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
);

export function isAllowedAttachmentContentType(
  contentType: string,
): contentType is AllowedAttachmentContentType {
  // Normalize: type/subtype only (strip parameters like charset).
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowedContentTypeSet.has(base);
}

export function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Sanitize a client fileName for storage and Content-Disposition.
 * Strips path segments and control chars; caps length at 180.
 */
export function sanitizeAttachmentFileName(fileName: string): string {
  const noPath = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  // Strip C0 controls + DEL without a control-character character class (eslint).
  let stripped = "";
  for (const ch of noPath) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || ch === '"' ) {
      continue;
    }
    stripped += ch;
  }
  stripped = stripped.trim();
  const fallback = stripped.length > 0 ? stripped : "attachment";
  return fallback.length > 180 ? fallback.slice(0, 180) : fallback;
}

/** Server-only S3 key template (fileName never enters the key). */
export function buildAttachmentS3Key(
  tripId: string,
  itemId: string,
  attachmentId: string,
): string {
  return `trips/${tripId}/items/${itemId}/${attachmentId}`;
}

export const AttachmentStatus = S.Literal("pending", "ready");
export type AttachmentStatus = typeof AttachmentStatus.Type;

/** Non-negative integer byte length (stored / list metadata). */
const SizeBytesNonNeg = S.Number.pipe(
  S.int(),
  S.nonNegative(),
);

/** Positive integer byte length for uploads (valid HTTP Content-Length). */
const SizeBytesPositive = S.Number.pipe(
  S.int(),
  S.positive(),
  S.lessThanOrEqualTo(MAX_ATTACHMENT_SIZE_BYTES),
);

export const Attachment = S.Struct({
  attachmentId: S.String,
  tripId: S.String,
  itemId: S.String,
  s3Key: S.String,
  status: AttachmentStatus,
  contentType: S.String,
  sizeBytes: SizeBytesNonNeg,
  fileName: S.String.pipe(S.maxLength(180)),
  /** Pending upload TTL / expiry instant. */
  expiresAt: S.optional(Instant),
  createdAt: Instant,
});
export type Attachment = typeof Attachment.Type;

/**
 * Public metadata (owner list + share trip). Omits s3Key (server-internal).
 */
export const AttachmentMeta = S.Struct({
  attachmentId: S.String,
  tripId: S.String,
  itemId: S.String,
  status: AttachmentStatus,
  contentType: S.String,
  sizeBytes: SizeBytesNonNeg,
  fileName: S.String.pipe(S.maxLength(180)),
  createdAt: Instant,
  expiresAt: S.optional(Instant),
});
export type AttachmentMeta = typeof AttachmentMeta.Type;

export const PresignAttachment = S.Struct({
  contentType: S.String.pipe(S.minLength(1), S.maxLength(128)),
  fileName: S.String.pipe(S.minLength(1), S.maxLength(180)),
  sizeBytes: SizeBytesPositive,
});
export type PresignAttachment = typeof PresignAttachment.Type;

export const PresignAttachmentResponse = S.Struct({
  attachmentId: S.String,
  s3Key: S.String,
  uploadUrl: S.String,
  /** Headers the client must send on the PUT (signed). */
  requiredHeaders: S.Record({ key: S.String, value: S.String }),
  expiresIn: S.Number.pipe(S.positive()),
});
export type PresignAttachmentResponse = typeof PresignAttachmentResponse.Type;

export const AttachmentListResponse = S.Struct({
  attachments: S.Array(AttachmentMeta),
});
export type AttachmentListResponse = typeof AttachmentListResponse.Type;

export const AttachmentDownloadUrlResponse = S.Struct({
  url: S.String,
  expiresIn: S.Number.pipe(S.positive()),
});
export type AttachmentDownloadUrlResponse =
  typeof AttachmentDownloadUrlResponse.Type;

export function toAttachmentMeta(att: Attachment): AttachmentMeta {
  return {
    attachmentId: att.attachmentId,
    tripId: att.tripId,
    itemId: att.itemId,
    status: att.status,
    contentType: att.contentType,
    sizeBytes: att.sizeBytes,
    fileName: att.fileName,
    createdAt: att.createdAt,
    ...(att.expiresAt !== undefined ? { expiresAt: att.expiresAt } : {}),
  };
}
