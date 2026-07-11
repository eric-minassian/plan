import { Schema as S } from "effect";

/**
 * Stable API error type codes (design error envelope).
 */
export const ApiErrorType = S.Literal(
  "NotFound",
  "Forbidden",
  "Unauthorized",
  "ValidationError",
  "MethodNotAllowed",
  "Conflict",
  "PayloadTooLarge",
  "RateLimited",
  "UpstreamUnavailable",
  "AmbiguousEnrichment",
  "InternalError",
);
export type ApiErrorType = typeof ApiErrorType.Type;

/** Const object for ergonomic imports without stringly typing. */
export const ErrorCode = {
  NotFound: "NotFound",
  Forbidden: "Forbidden",
  Unauthorized: "Unauthorized",
  ValidationError: "ValidationError",
  MethodNotAllowed: "MethodNotAllowed",
  Conflict: "Conflict",
  PayloadTooLarge: "PayloadTooLarge",
  RateLimited: "RateLimited",
  UpstreamUnavailable: "UpstreamUnavailable",
  AmbiguousEnrichment: "AmbiguousEnrichment",
  InternalError: "InternalError",
} as const satisfies Record<ApiErrorType, ApiErrorType>;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Default HTTP status for each error type.
 * Enrichment “schedule not found” is a 200 success DTO, not this envelope.
 */
export const ErrorHttpStatus: Record<ApiErrorType, number> = {
  ValidationError: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  PayloadTooLarge: 413,
  AmbiguousEnrichment: 422,
  RateLimited: 429,
  InternalError: 500,
  UpstreamUnavailable: 502,
};

export const ApiErrorBody = S.Struct({
  type: ApiErrorType,
  message: S.String,
  details: S.optional(S.Unknown),
  retryable: S.Boolean,
  requestId: S.String,
});
export type ApiErrorBody = typeof ApiErrorBody.Type;

/** Which error types are retryable by default. */
export function isRetryableErrorType(type: ApiErrorType): boolean {
  return type === "RateLimited" || type === "UpstreamUnavailable" || type === "InternalError";
}

export function makeApiErrorBody(input: {
  type: ApiErrorType;
  message: string;
  requestId: string;
  details?: unknown;
  retryable?: boolean;
}): ApiErrorBody {
  return {
    type: input.type,
    message: input.message,
    ...(input.details !== undefined ? { details: input.details } : {}),
    retryable: input.retryable ?? isRetryableErrorType(input.type),
    requestId: input.requestId,
  };
}
