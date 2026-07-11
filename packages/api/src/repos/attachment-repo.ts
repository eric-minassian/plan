import type { Attachment, AttachmentStatus } from "@tripplan/domain";
import {
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_PENDING_ATTACHMENTS_PER_ITEM,
  PENDING_ATTACHMENT_TTL_SECONDS,
  normalizeInstant,
} from "@tripplan/domain";
import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";

export {
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_PENDING_ATTACHMENTS_PER_ITEM,
  PENDING_ATTACHMENT_TTL_SECONDS,
};

export interface CreatePendingAttachmentInput {
  readonly tripId: string;
  readonly itemId: string;
  readonly attachmentId: string;
  readonly s3Key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
  /** Optional override for tests. */
  readonly now?: Date;
}

export interface AttachmentRepository {
  /**
   * Create a pending attachment row (TTL 24h).
   * Caller enforces item ownership + quotas before calling.
   */
  readonly createPending: (
    input: CreatePendingAttachmentInput,
  ) => Effect.Effect<Attachment, AppError>;

  /** GetItem by PK=TRIP#tripId SK=ATT#itemId#attachmentId. */
  readonly get: (
    tripId: string,
    itemId: string,
    attachmentId: string,
  ) => Effect.Effect<Attachment | undefined, AppError>;

  /** List all attachments for an item (pending + ready), oldest first. */
  readonly listForItem: (
    tripId: string,
    itemId: string,
  ) => Effect.Effect<readonly Attachment[], AppError>;

  /**
   * List ready attachments for a trip (share viewer).
   * Query SK begins_with ATT# and filter status=ready.
   */
  readonly listReadyForTrip: (
    tripId: string,
  ) => Effect.Effect<readonly Attachment[], AppError>;

  /** Mark pending → ready and clear expiresAt/ttl. 404 if missing; 409 if not pending. */
  readonly confirmReady: (
    tripId: string,
    itemId: string,
    attachmentId: string,
  ) => Effect.Effect<Attachment, AppError>;

  /** Delete attachment row. No-op semantics: 404 if missing. */
  readonly delete: (
    tripId: string,
    itemId: string,
    attachmentId: string,
  ) => Effect.Effect<void, AppError>;

  /** Delete all attachment rows for an item (sync cascade). Returns deleted keys. */
  readonly deleteAllForItem: (
    tripId: string,
    itemId: string,
  ) => Effect.Effect<readonly Attachment[], AppError>;
}

export class AttachmentRepo extends Context.Tag("AttachmentRepo")<
  AttachmentRepo,
  AttachmentRepository
>() {}

function nowInstant(now: Date = new Date()): string {
  return normalizeInstant(now.toISOString());
}

function addSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

export function attKey(
  tripId: string,
  itemId: string,
  attachmentId: string,
): string {
  return `${tripId}\0${itemId}\0${attachmentId}`;
}

/**
 * In-memory attachment store for unit tests and local skeleton without Dynamo.
 */
export function makeInMemoryAttachmentRepo(
  seed: Iterable<Attachment> = [],
): AttachmentRepository {
  const store = new Map<string, Attachment>();

  for (const att of seed) {
    store.set(attKey(att.tripId, att.itemId, att.attachmentId), att);
  }

  const listItem = (tripId: string, itemId: string): Attachment[] => {
    const out: Attachment[] = [];
    for (const att of store.values()) {
      if (att.tripId === tripId && att.itemId === itemId) {
        out.push(att);
      }
    }
    out.sort((a, b) =>
      a.createdAt < b.createdAt
        ? -1
        : a.createdAt > b.createdAt
          ? 1
          : a.attachmentId < b.attachmentId
            ? -1
            : a.attachmentId > b.attachmentId
              ? 1
              : 0,
    );
    return out;
  };

  return {
    createPending: (input) =>
      Effect.try({
        try: () => {
          const key = attKey(
            input.tripId,
            input.itemId,
            input.attachmentId,
          );
          if (store.has(key)) {
            throw AppError.conflict("Attachment already exists");
          }
          const now = input.now ?? new Date();
          const createdAt = nowInstant(now);
          const expiresAt = nowInstant(
            addSeconds(now, PENDING_ATTACHMENT_TTL_SECONDS),
          );
          const att: Attachment = {
            attachmentId: input.attachmentId,
            tripId: input.tripId,
            itemId: input.itemId,
            s3Key: input.s3Key,
            status: "pending",
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            fileName: input.fileName,
            expiresAt,
            createdAt,
          };
          store.set(key, att);
          return att;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    get: (tripId, itemId, attachmentId) =>
      Effect.sync(
        () => store.get(attKey(tripId, itemId, attachmentId)),
      ),

    listForItem: (tripId, itemId) =>
      Effect.sync(() => listItem(tripId, itemId)),

    listReadyForTrip: (tripId) =>
      Effect.sync(() => {
        const out: Attachment[] = [];
        for (const att of store.values()) {
          if (att.tripId === tripId && att.status === "ready") {
            out.push(att);
          }
        }
        out.sort((a, b) =>
          a.createdAt < b.createdAt
            ? -1
            : a.createdAt > b.createdAt
              ? 1
              : a.attachmentId < b.attachmentId
                ? -1
                : a.attachmentId > b.attachmentId
                  ? 1
                  : 0,
        );
        return out;
      }),

    confirmReady: (tripId, itemId, attachmentId) =>
      Effect.try({
        try: () => {
          const key = attKey(tripId, itemId, attachmentId);
          const existing = store.get(key);
          if (existing === undefined) {
            throw AppError.notFound("Attachment not found");
          }
          if (existing.status !== "pending") {
            throw AppError.conflict("Attachment is not pending", {
              status: existing.status,
            });
          }
          const ready: Attachment = {
            attachmentId: existing.attachmentId,
            tripId: existing.tripId,
            itemId: existing.itemId,
            s3Key: existing.s3Key,
            status: "ready" satisfies AttachmentStatus,
            contentType: existing.contentType,
            sizeBytes: existing.sizeBytes,
            fileName: existing.fileName,
            createdAt: existing.createdAt,
          };
          store.set(key, ready);
          return ready;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    delete: (tripId, itemId, attachmentId) =>
      Effect.try({
        try: () => {
          const key = attKey(tripId, itemId, attachmentId);
          if (!store.has(key)) {
            throw AppError.notFound("Attachment not found");
          }
          store.delete(key);
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    deleteAllForItem: (tripId, itemId) =>
      Effect.sync(() => {
        const existing = listItem(tripId, itemId);
        for (const att of existing) {
          store.delete(attKey(att.tripId, att.itemId, att.attachmentId));
        }
        return existing;
      }),
  };
}

/** Count pending attachments in a list. */
export function countPending(
  attachments: readonly Attachment[],
): number {
  return attachments.filter((a) => a.status === "pending").length;
}
