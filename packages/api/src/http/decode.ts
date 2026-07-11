import { Schema as S, Either } from "effect";
import { AppError } from "../errors/app-error.js";

/**
 * Decode JSON request body with an Effect Schema.
 * Empty/missing body → ValidationError.
 */
export function decodeJsonBody<A, I>(
  schema: S.Schema<A, I, never>,
  body: string | undefined,
): Either.Either<A, AppError> {
  if (body === undefined || body.trim().length === 0) {
    return Either.left(AppError.validation("Request body is required"));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return Either.left(AppError.validation("Invalid JSON body"));
  }
  const decoded = S.decodeUnknownEither(schema)(raw);
  if (Either.isLeft(decoded)) {
    return Either.left(
      AppError.validation("Request validation failed", {
        issues: String(decoded.left),
      }),
    );
  }
  return Either.right(decoded.right);
}

/**
 * Parse `If-Match` header as opaque integer version string.
 * Accepts `1`, `"1"`, or W/"1" (weak) — stores as integer.
 */
export function parseIfMatchVersion(
  header: string | undefined,
): Either.Either<number, AppError> {
  if (header === undefined || header.trim().length === 0) {
    return Either.left(
      AppError.validation("If-Match header is required"),
    );
  }
  let raw = header.trim();
  if (raw.startsWith("W/")) {
    raw = raw.slice(2).trim();
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  if (!/^\d+$/.test(raw)) {
    return Either.left(
      AppError.validation("If-Match must be an integer version string"),
    );
  }
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) {
    return Either.left(
      AppError.validation("If-Match must be a positive integer version"),
    );
  }
  return Either.right(version);
}

/** Format version for ETag response header (opaque quoted string). */
export function etagFromVersion(version: number): string {
  return `"${version}"`;
}
