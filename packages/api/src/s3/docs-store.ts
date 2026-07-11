import {
  PRESIGN_GET_EXPIRES_SECONDS,
  PRESIGN_PUT_EXPIRES_SECONDS,
  sanitizeAttachmentFileName,
} from "@tripplan/domain";
import {
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Context, Effect } from "effect";
import { internalFromCause } from "../errors/app-error.js";
import type { AppError } from "../errors/app-error.js";

/** Tag applied on unconfirmed PUT objects (S3 lifecycle expires pending=true). */
export const PENDING_OBJECT_TAG = "pending=true" as const;

export interface HeadObjectResult {
  readonly contentLength: number;
  readonly contentType: string | undefined;
}

export interface PresignPutInput {
  readonly key: string;
  readonly contentType: string;
  readonly contentLength: number;
}

export interface PresignPutResult {
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresIn: number;
}

export interface PresignGetInput {
  readonly key: string;
  readonly fileName: string;
  readonly contentType: string;
}

export interface PresignGetResult {
  readonly url: string;
  readonly expiresIn: number;
}

/**
 * Documents bucket access: presigned PUT/GET, HeadObject, tag clear, delete.
 */
export interface DocsStoreService {
  readonly presignPut: (
    input: PresignPutInput,
  ) => Effect.Effect<PresignPutResult, AppError>;

  readonly headObject: (
    key: string,
  ) => Effect.Effect<HeadObjectResult | undefined, AppError>;

  /** Clear lifecycle tag so confirmed objects are not expired. */
  readonly clearPendingTag: (
    key: string,
  ) => Effect.Effect<void, AppError>;

  readonly presignGet: (
    input: PresignGetInput,
  ) => Effect.Effect<PresignGetResult, AppError>;

  readonly deleteObject: (key: string) => Effect.Effect<void, AppError>;
}

export class DocsStore extends Context.Tag("DocsStore")<
  DocsStore,
  DocsStoreService
>() {}

function contentDispositionAttachment(fileName: string): string {
  const safe = sanitizeAttachmentFileName(fileName);
  // ASCII fallback + RFC 5987 filename*
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Build an S3 client safe for **presigned PUT without Body**.
 *
 * Default SDK flexible checksums embed CRC32 of an empty body into the URL
 * (`x-amz-checksum-crc32=AAAAAA==`), which breaks real browser uploads.
 * `requestChecksumCalculation: "WHEN_REQUIRED"` disables that for presign.
 */
export function createDocsS3Client(options: {
  readonly region: string;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
}): S3Client {
  return new S3Client({
    region: options.region,
    // Prevent empty-body flexible CRC32 from being signed into PUT URLs.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(options.credentials !== undefined
      ? { credentials: options.credentials }
      : {}),
  });
}

/** Headers the browser must send on the signed PUT (match X-Amz-SignedHeaders). */
export const PRESIGN_PUT_SIGNED_HEADER_NAMES = [
  "content-type",
  "content-length",
  "x-amz-tagging",
] as const;

export function makeS3DocsStore(options: {
  readonly bucketName: string;
  readonly region?: string;
  readonly client?: S3Client;
  readonly putExpiresSeconds?: number;
  readonly getExpiresSeconds?: number;
}): DocsStoreService {
  const bucket = options.bucketName;
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  const client =
    options.client ??
    createDocsS3Client({ region });
  const putExpires =
    options.putExpiresSeconds ?? PRESIGN_PUT_EXPIRES_SECONDS;
  const getExpires =
    options.getExpiresSeconds ?? PRESIGN_GET_EXPIRES_SECONDS;

  return {
    presignPut: (input) =>
      Effect.tryPromise({
        try: async () => {
          const command = new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            ContentType: input.contentType,
            ContentLength: input.contentLength,
            Tagging: PENDING_OBJECT_TAG,
          });
          const uploadUrl = await getSignedUrl(client, command, {
            expiresIn: putExpires,
            // Keep tagging as a request header (design + requiredHeaders), not query.
            signableHeaders: new Set([...PRESIGN_PUT_SIGNED_HEADER_NAMES]),
            unhoistableHeaders: new Set(["x-amz-tagging"]),
          });
          const requiredHeaders: Record<string, string> = {
            "Content-Type": input.contentType,
            "Content-Length": String(input.contentLength),
            "x-amz-tagging": PENDING_OBJECT_TAG,
          };
          return { uploadUrl, requiredHeaders, expiresIn: putExpires };
        },
        catch: (cause) =>
          internalFromCause(cause, { component: "s3-docs-store-presign-put" }),
      }),

    headObject: (key) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const result = await client.send(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: key,
              }),
            );
            const contentLength = result.ContentLength;
            if (contentLength === undefined) {
              return undefined;
            }
            return {
              contentLength,
              contentType: result.ContentType,
            };
          } catch (cause: unknown) {
            if (isNotFound(cause)) {
              return undefined;
            }
            throw cause;
          }
        },
        catch: (cause) =>
          internalFromCause(cause, { component: "s3-docs-store-head" }),
      }),

    clearPendingTag: (key) =>
      Effect.tryPromise({
        try: async () => {
          try {
            await client.send(
              new DeleteObjectTaggingCommand({
                Bucket: bucket,
                Key: key,
              }),
            );
          } catch (cause: unknown) {
            if (isNotFound(cause)) {
              return;
            }
            throw cause;
          }
        },
        catch: (cause) =>
          internalFromCause(cause, {
            component: "s3-docs-store-clear-tag",
          }),
      }),

    presignGet: (input) =>
      Effect.tryPromise({
        try: async () => {
          const command = new GetObjectCommand({
            Bucket: bucket,
            Key: input.key,
            ResponseContentDisposition: contentDispositionAttachment(
              input.fileName,
            ),
            ResponseContentType: input.contentType,
          });
          const url = await getSignedUrl(client, command, {
            expiresIn: getExpires,
          });
          return { url, expiresIn: getExpires };
        },
        catch: (cause) =>
          internalFromCause(cause, { component: "s3-docs-store-presign-get" }),
      }),

    deleteObject: (key) =>
      Effect.tryPromise({
        try: async () => {
          await client.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key,
            }),
          );
        },
        catch: (cause) =>
          internalFromCause(cause, { component: "s3-docs-store-delete" }),
      }),
  };
}

function isNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const name =
    "name" in cause && typeof (cause as { name: unknown }).name === "string"
      ? (cause as { name: string }).name
      : "";
  const statusCode =
    "$metadata" in cause &&
    typeof (cause as { $metadata?: { httpStatusCode?: number } }).$metadata ===
      "object"
      ? (cause as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
      : undefined;
  return (
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NotFoundException" ||
    statusCode === 404
  );
}

// ---------------------------------------------------------------------------
// In-memory mock S3 (unit tests)
// ---------------------------------------------------------------------------

export interface MockS3Object {
  readonly contentType: string;
  readonly contentLength: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface MockDocsStore extends DocsStoreService {
  /** Simulate a client PUT after presign (enforces signed headers). */
  readonly simulatePut: (
    key: string,
    headers: Readonly<Record<string, string>>,
    body?: Uint8Array,
  ) => void;
  readonly getObject: (key: string) => MockS3Object | undefined;
  readonly objects: Map<string, MockS3Object>;
}

/**
 * In-memory docs store for unit tests.
 * `presignPut` records expected headers; `simulatePut` validates them.
 */
export function makeMockDocsStore(options?: {
  readonly putExpiresSeconds?: number;
  readonly getExpiresSeconds?: number;
  readonly baseUrl?: string;
}): MockDocsStore {
  const objects = new Map<string, MockS3Object>();
  const pendingPresigns = new Map<
    string,
    { contentType: string; contentLength: number }
  >();
  const putExpires =
    options?.putExpiresSeconds ?? PRESIGN_PUT_EXPIRES_SECONDS;
  const getExpires =
    options?.getExpiresSeconds ?? PRESIGN_GET_EXPIRES_SECONDS;
  const baseUrl = options?.baseUrl ?? "https://mock-docs.s3.us-east-1.amazonaws.com";

  const store: MockDocsStore = {
    objects,

    getObject: (key) => objects.get(key),

    simulatePut: (key, headers, body) => {
      const expected = pendingPresigns.get(key);
      if (expected === undefined) {
        throw new Error(`No presign for key ${key}`);
      }
      const contentType = headerValue(headers, "Content-Type");
      const contentLengthRaw = headerValue(headers, "Content-Length");
      const tagging = headerValue(headers, "x-amz-tagging");
      if (contentType !== expected.contentType) {
        throw new Error(
          `Content-Type mismatch: got ${contentType}, expected ${expected.contentType}`,
        );
      }
      if (contentLengthRaw !== String(expected.contentLength)) {
        throw new Error(
          `Content-Length mismatch: got ${contentLengthRaw}, expected ${expected.contentLength}`,
        );
      }
      if (tagging !== PENDING_OBJECT_TAG) {
        throw new Error(`x-amz-tagging must be ${PENDING_OBJECT_TAG}`);
      }
      if (
        body !== undefined &&
        body.byteLength !== expected.contentLength
      ) {
        throw new Error(
          `Body length ${body.byteLength} !== Content-Length ${expected.contentLength}`,
        );
      }
      objects.set(key, {
        contentType: expected.contentType,
        contentLength: expected.contentLength,
        tags: { pending: "true" },
        ...(body !== undefined ? { body } : {}),
      });
    },

    presignPut: (input) =>
      Effect.sync(() => {
        pendingPresigns.set(input.key, {
          contentType: input.contentType,
          contentLength: input.contentLength,
        });
        const requiredHeaders: Record<string, string> = {
          "Content-Type": input.contentType,
          "Content-Length": String(input.contentLength),
          "x-amz-tagging": PENDING_OBJECT_TAG,
        };
        return {
          uploadUrl: `${baseUrl}/${input.key}?X-Amz-Signature=mock&X-Amz-Expires=${putExpires}`,
          requiredHeaders,
          expiresIn: putExpires,
        };
      }),

    headObject: (key) =>
      Effect.sync(() => {
        const obj = objects.get(key);
        if (obj === undefined) {
          return undefined;
        }
        return {
          contentLength: obj.contentLength,
          contentType: obj.contentType,
        };
      }),

    clearPendingTag: (key) =>
      Effect.sync(() => {
        const obj = objects.get(key);
        if (obj === undefined) {
          return;
        }
        const { pending: _removed, ...rest } = obj.tags;
        objects.set(key, {
          ...obj,
          tags: rest,
        });
      }),

    presignGet: (input) =>
      Effect.sync(() => {
        const disposition = contentDispositionAttachment(input.fileName);
        const url =
          `${baseUrl}/${input.key}` +
          `?response-content-disposition=${encodeURIComponent(disposition)}` +
          `&response-content-type=${encodeURIComponent(input.contentType)}` +
          `&X-Amz-Signature=mock&X-Amz-Expires=${getExpires}`;
        return { url, expiresIn: getExpires };
      }),

    deleteObject: (key) =>
      Effect.sync(() => {
        objects.delete(key);
        pendingPresigns.delete(key);
      }),
  };

  return store;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}
