import {
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  PresignAttachment,
  buildAttachmentS3Key,
  isAllowedAttachmentContentType,
  normalizeContentType,
  sanitizeAttachmentFileName,
  toAttachmentMeta,
  type Attachment,
  type AttachmentDownloadUrlResponse,
  type AttachmentListResponse,
  type PresignAttachmentResponse,
} from "@tripplan/domain";
import { Effect, Either } from "effect";
import { CurrentOwner } from "../auth/current-owner.js";
import { CurrentShare } from "../auth/current-share.js";
import { AppError } from "../errors/app-error.js";
import { decodeJsonBody } from "../http/decode.js";
import { RequestContext } from "../http/request-context.js";
import { jsonResponse, type HttpResponse } from "../http/types.js";
import {
  AttachmentRepo,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_PENDING_ATTACHMENTS_PER_ITEM,
  countPending,
} from "../repos/attachment-repo.js";
import { TripRepo } from "../repos/trip-repo.js";
import { DocsStore } from "../s3/docs-store.js";

function requirePathParam(
  params: Readonly<Record<string, string>>,
  name: string,
): Effect.Effect<string, AppError> {
  const value = params[name];
  if (value === undefined || value.length === 0) {
    return Effect.fail(AppError.validation(`Missing path parameter: ${name}`));
  }
  return Effect.succeed(value);
}

/**
 * Ensure the owner has an active trip + the item exists.
 * Returns nothing; fails with 404 on missing trip/item.
 */
function requireOwnedItem(
  ownerId: string,
  tripId: string,
  itemId: string,
): Effect.Effect<void, AppError, TripRepo> {
  return Effect.gen(function* () {
    const trips = yield* TripRepo;
    const item = yield* trips.getItem(ownerId, tripId, itemId);
    if (item === undefined) {
      return yield* Effect.fail(AppError.notFound("Item not found"));
    }
  });
}

function requireReadyAttachment(
  att: Attachment | undefined,
): Effect.Effect<Attachment, AppError> {
  if (att === undefined) {
    return Effect.fail(AppError.notFound("Attachment not found"));
  }
  if (att.status !== "ready") {
    return Effect.fail(
      AppError.conflict("Attachment is not ready", { status: att.status }),
    );
  }
  return Effect.succeed(att);
}

/** GET /api/v1/trips/:tripId/items/:itemId/attachments */
export function handleListAttachments(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const attachments = yield* AttachmentRepo;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");

    yield* requireOwnedItem(principal.sub, tripId, itemId);
    const rows = yield* attachments.listForItem(tripId, itemId);
    const body: AttachmentListResponse = {
      attachments: rows.map(toAttachmentMeta),
    };
    return jsonResponse(200, body);
  });
}

/** POST /api/v1/trips/:tripId/items/:itemId/attachments/presign */
export function handlePresignAttachment(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const { request, pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");

    yield* requireOwnedItem(principal.sub, tripId, itemId);

    const decoded = decodeJsonBody(PresignAttachment, request.body);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }
    const input = decoded.right;

    const contentType = normalizeContentType(input.contentType);
    if (!isAllowedAttachmentContentType(contentType)) {
      return yield* Effect.fail(
        AppError.validation(
          `contentType must be one of: ${ALLOWED_ATTACHMENT_CONTENT_TYPES.join(", ")}`,
          { contentType: input.contentType },
        ),
      );
    }

    // Sanitize for Content-Disposition / storage display (always non-empty).
    const fileName = sanitizeAttachmentFileName(input.fileName);

    // Quota is check-then-act (best-effort under concurrent presigns; same class
    // as item quotas). Serial path hard-rejects at the ceiling.
    const existing = yield* attachments.listForItem(tripId, itemId);
    if (existing.length >= MAX_ATTACHMENTS_PER_ITEM) {
      return yield* Effect.fail(
        AppError.validation(
          `Attachment limit reached (max ${MAX_ATTACHMENTS_PER_ITEM} per item)`,
          { maxAttachments: MAX_ATTACHMENTS_PER_ITEM },
        ),
      );
    }
    if (countPending(existing) >= MAX_PENDING_ATTACHMENTS_PER_ITEM) {
      return yield* Effect.fail(
        AppError.validation(
          `Too many pending uploads (max ${MAX_PENDING_ATTACHMENTS_PER_ITEM} concurrent)`,
          { maxPending: MAX_PENDING_ATTACHMENTS_PER_ITEM },
        ),
      );
    }

    const attachmentId = crypto.randomUUID();
    const s3Key = buildAttachmentS3Key(tripId, itemId, attachmentId);

    yield* attachments.createPending({
      tripId,
      itemId,
      attachmentId,
      s3Key,
      contentType,
      sizeBytes: input.sizeBytes,
      fileName,
    });

    const signed = yield* docs.presignPut({
      key: s3Key,
      contentType,
      contentLength: input.sizeBytes,
    });

    const body: PresignAttachmentResponse = {
      attachmentId,
      s3Key,
      uploadUrl: signed.uploadUrl,
      requiredHeaders: signed.requiredHeaders,
      expiresIn: signed.expiresIn,
    };
    return jsonResponse(201, body);
  });
}

/** POST /api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId/confirm */
export function handleConfirmAttachment(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");
    const attachmentId = yield* requirePathParam(pathParams, "attachmentId");

    yield* requireOwnedItem(principal.sub, tripId, itemId);

    const existing = yield* attachments.get(tripId, itemId, attachmentId);
    if (existing === undefined) {
      return yield* Effect.fail(AppError.notFound("Attachment not found"));
    }
    if (existing.status === "ready") {
      // Idempotent confirm — return current metadata.
      return jsonResponse(200, toAttachmentMeta(existing));
    }
    if (existing.status !== "pending") {
      return yield* Effect.fail(
        AppError.conflict("Attachment is not pending", {
          status: existing.status,
        }),
      );
    }

    const head = yield* docs.headObject(existing.s3Key);
    if (head === undefined) {
      return yield* Effect.fail(
        AppError.validation("Object not found in storage; upload first"),
      );
    }
    if (head.contentLength !== existing.sizeBytes) {
      return yield* Effect.fail(
        AppError.validation(
          "Uploaded object size does not match declared sizeBytes",
          {
            expected: existing.sizeBytes,
            actual: head.contentLength,
          },
        ),
      );
    }
    // Fail closed: require HeadObject Content-Type to match the declared type.
    if (
      head.contentType === undefined ||
      head.contentType.trim().length === 0
    ) {
      return yield* Effect.fail(
        AppError.validation(
          "Uploaded object is missing Content-Type; re-upload with declared type",
        ),
      );
    }
    const actual = normalizeContentType(head.contentType);
    if (actual !== existing.contentType) {
      return yield* Effect.fail(
        AppError.validation(
          "Uploaded Content-Type does not match declared contentType",
          {
            expected: existing.contentType,
            actual: head.contentType,
          },
        ),
      );
    }

    yield* docs.clearPendingTag(existing.s3Key);
    // Concurrent confirm: if another request already flipped to ready, return
    // that meta (true idempotency) instead of 409.
    const readyOrConflict = yield* attachments.confirmReady(
      tripId,
      itemId,
      attachmentId,
    ).pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          if (err.type !== "Conflict") {
            return yield* Effect.fail(err);
          }
          const live = yield* attachments.get(tripId, itemId, attachmentId);
          if (live !== undefined && live.status === "ready") {
            return live;
          }
          return yield* Effect.fail(err);
        }),
      ),
    );
    return jsonResponse(200, toAttachmentMeta(readyOrConflict));
  });
}

/** GET /api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId/url */
export function handleOwnerAttachmentUrl(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");
    const attachmentId = yield* requirePathParam(pathParams, "attachmentId");

    yield* requireOwnedItem(principal.sub, tripId, itemId);

    const att = yield* attachments.get(tripId, itemId, attachmentId);
    const ready = yield* requireReadyAttachment(att);

    const signed = yield* docs.presignGet({
      key: ready.s3Key,
      fileName: ready.fileName,
      contentType: ready.contentType,
    });
    const body: AttachmentDownloadUrlResponse = {
      url: signed.url,
      expiresIn: signed.expiresIn,
    };
    return jsonResponse(200, body);
  });
}

/** DELETE /api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId */
export function handleDeleteAttachment(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentOwner | TripRepo | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentOwner;
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const { pathParams } = yield* RequestContext;
    const tripId = yield* requirePathParam(pathParams, "tripId");
    const itemId = yield* requirePathParam(pathParams, "itemId");
    const attachmentId = yield* requirePathParam(pathParams, "attachmentId");

    yield* requireOwnedItem(principal.sub, tripId, itemId);

    const existing = yield* attachments.get(tripId, itemId, attachmentId);
    if (existing === undefined) {
      return yield* Effect.fail(AppError.notFound("Attachment not found"));
    }

    // DDB first so a failed S3 delete leaves an orphan object (lifecycle/worker
    // can sweep) rather than a live ATT row pointing at a missing object.
    yield* attachments.delete(tripId, itemId, attachmentId);
    yield* docs.deleteObject(existing.s3Key);
    return { status: 204 };
  });
}

/**
 * GET /api/v1/share/items/:itemId/attachments/:attachmentId/url
 * Session supplies tripId; GetItem ATT#itemId#attachmentId; ready only.
 */
export function handleShareAttachmentUrl(): Effect.Effect<
  HttpResponse,
  AppError,
  CurrentShare | AttachmentRepo | DocsStore | RequestContext
> {
  return Effect.gen(function* () {
    const principal = yield* CurrentShare;
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const { pathParams } = yield* RequestContext;
    const itemId = yield* requirePathParam(pathParams, "itemId");
    const attachmentId = yield* requirePathParam(pathParams, "attachmentId");

    const att = yield* attachments.get(
      principal.tripId,
      itemId,
      attachmentId,
    );
    const ready = yield* requireReadyAttachment(att);

    const signed = yield* docs.presignGet({
      key: ready.s3Key,
      fileName: ready.fileName,
      contentType: ready.contentType,
    });
    const body: AttachmentDownloadUrlResponse = {
      url: signed.url,
      expiresIn: signed.expiresIn,
    };
    return jsonResponse(200, body);
  });
}

/**
 * Cascade-delete all attachments (DDB + S3) for an item.
 * Best-effort S3 deletes; DDB rows always removed.
 */
export function cascadeDeleteItemAttachments(
  tripId: string,
  itemId: string,
): Effect.Effect<void, AppError, AttachmentRepo | DocsStore> {
  return Effect.gen(function* () {
    const attachments = yield* AttachmentRepo;
    const docs = yield* DocsStore;
    const deleted = yield* attachments.deleteAllForItem(tripId, itemId);
    for (const att of deleted) {
      // Ignore individual S3 failures after DDB delete — trip worker can sweep.
      yield* docs.deleteObject(att.s3Key).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  });
}
