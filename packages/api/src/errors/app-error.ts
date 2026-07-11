import {
  ErrorCode,
  ErrorHttpStatus,
  makeApiErrorBody,
  type ApiErrorBody,
  type ApiErrorType,
} from "@tripplan/domain";
import { Data } from "effect";
import { jsonResponse, type HttpResponse } from "../http/types.js";
import { consoleLogger, type Logger } from "../logging/logger.js";

/** Client-facing message for InternalError — never include cause text. */
export const INTERNAL_ERROR_MESSAGE = "Internal server error" as const;

/**
 * Tagged application errors that map 1:1 onto the domain ApiErrorBody envelope.
 */
export class AppError extends Data.TaggedError("AppError")<{
  readonly type: ApiErrorType;
  readonly message: string;
  readonly details?: unknown;
  readonly retryable?: boolean;
  /** Optional WWW-Authenticate challenge (Unauthorized). */
  readonly wwwAuthenticate?: string;
}> {
  static unauthorized(
    message = "Authentication required",
    wwwAuthenticate?: string,
  ): AppError {
    return new AppError({
      type: ErrorCode.Unauthorized,
      message,
      wwwAuthenticate,
    });
  }

  static forbidden(message = "Forbidden"): AppError {
    return new AppError({ type: ErrorCode.Forbidden, message });
  }

  static notFound(message = "Not found"): AppError {
    return new AppError({ type: ErrorCode.NotFound, message });
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError({
      type: ErrorCode.ValidationError,
      message,
      details,
    });
  }

  static methodNotAllowed(message = "Method not allowed"): AppError {
    return new AppError({
      type: ErrorCode.MethodNotAllowed,
      message,
      retryable: false,
    });
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError({ type: ErrorCode.Conflict, message, details });
  }

  /** Trip deleted/deleting — share viewers get 410 Gone. */
  static gone(message = "Trip is no longer available"): AppError {
    return new AppError({ type: ErrorCode.Gone, message });
  }

  static rateLimited(
    message = "Too many requests",
    details?: unknown,
  ): AppError {
    return new AppError({
      type: ErrorCode.RateLimited,
      message,
      details,
      retryable: true,
    });
  }

  static upstreamUnavailable(
    message = "Upstream service unavailable",
    details?: unknown,
  ): AppError {
    return new AppError({
      type: ErrorCode.UpstreamUnavailable,
      message,
      details,
      retryable: true,
    });
  }

  static ambiguousEnrichment(
    message: string,
    details?: unknown,
  ): AppError {
    return new AppError({
      type: ErrorCode.AmbiguousEnrichment,
      message,
      details,
      retryable: false,
    });
  }

  /**
   * Client-safe internal error. Message is always {@link INTERNAL_ERROR_MESSAGE};
   * log the real cause separately with {@link logInternalCause}.
   */
  static internal(): AppError {
    return new AppError({
      type: ErrorCode.InternalError,
      message: INTERNAL_ERROR_MESSAGE,
    });
  }
}

/**
 * Log unexpected failure details server-side only (never put cause text in ApiErrorBody).
 */
export function logInternalCause(
  cause: unknown,
  fields: Readonly<Record<string, string | number | boolean | undefined>> = {},
  logger: Logger = consoleLogger,
): void {
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "unknown";
  logger.log("error", "internal_error", {
    ...fields,
    cause: causeMessage,
  });
}

/** Build InternalError after logging the underlying cause. */
export function internalFromCause(
  cause: unknown,
  fields?: Readonly<Record<string, string | number | boolean | undefined>>,
  logger?: Logger,
): AppError {
  logInternalCause(cause, fields, logger);
  return AppError.internal();
}

export function appErrorToBody(
  error: AppError,
  requestId: string,
): ApiErrorBody {
  return makeApiErrorBody({
    type: error.type,
    message: error.message,
    requestId,
    details: error.details,
    retryable: error.retryable,
  });
}

export function statusForErrorType(type: ApiErrorType): number {
  // Exhaustive map — every ApiErrorType has a status in domain.
  const status = ErrorHttpStatus[type];
  return status ?? 500;
}

export function appErrorToHttpResponse(
  error: AppError,
  requestId: string,
): HttpResponse {
  const status = statusForErrorType(error.type);
  const headers: Record<string, string> = {};
  if (
    error.type === ErrorCode.Unauthorized &&
    error.wwwAuthenticate !== undefined
  ) {
    headers["www-authenticate"] = error.wwwAuthenticate;
  }
  return jsonResponse(status, appErrorToBody(error, requestId), headers);
}

/** Map unexpected failures to InternalError without leaking internals. */
export function unexpectedToAppError(
  cause: unknown,
  logger?: Logger,
): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return internalFromCause(cause, {}, logger);
}
