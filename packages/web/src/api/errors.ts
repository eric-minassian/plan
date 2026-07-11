import {
  ErrorCode,
  type ApiErrorBody,
  type ApiErrorType,
} from "@tripplan/domain";

/**
 * Error thrown by the SPA API client when the response is not OK.
 * Prefer {@link ApiClientError.body} for the server error envelope.
 */
export class ApiClientError extends Error {
  override readonly name = "ApiClientError";

  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | undefined,
    message?: string,
  ) {
    super(
      message ??
        body?.message ??
        `Request failed with status ${String(status)}`,
    );
  }

  get type(): ApiErrorType | undefined {
    return this.body?.type;
  }

  get requestId(): string | undefined {
    return this.body?.requestId;
  }

  get retryable(): boolean {
    return this.body?.retryable ?? false;
  }
}

/** Keep in lockstep with `@tripplan/domain` ErrorCode — no hand-maintained list. */
const API_ERROR_TYPES = new Set<string>(Object.values(ErrorCode));

/** Parse the TripPlan error envelope from a JSON body; returns undefined if shape mismatches. */
export function parseApiErrorBody(body: unknown): ApiErrorBody | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const type = record["type"];
  const message = record["message"];
  const retryable = record["retryable"];
  const requestId = record["requestId"];
  if (typeof type !== "string" || !API_ERROR_TYPES.has(type)) {
    return undefined;
  }
  if (typeof message !== "string") {
    return undefined;
  }
  if (typeof retryable !== "boolean") {
    return undefined;
  }
  if (typeof requestId !== "string") {
    return undefined;
  }
  const result: ApiErrorBody = {
    type: type as ApiErrorType,
    message,
    retryable,
    requestId,
  };
  if ("details" in record) {
    return { ...result, details: record["details"] };
  }
  return result;
}

function formatCandidate(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const dep =
    typeof record["departureAirport"] === "string"
      ? record["departureAirport"]
      : undefined;
  const arr =
    typeof record["arrivalAirport"] === "string"
      ? record["arrivalAirport"]
      : undefined;
  const fn =
    typeof record["flightNumber"] === "string"
      ? record["flightNumber"]
      : undefined;
  const airline =
    typeof record["airlineCode"] === "string"
      ? record["airlineCode"]
      : undefined;
  const route =
    dep !== undefined || arr !== undefined
      ? `${dep ?? "?" }→${arr ?? "?"}`
      : undefined;
  const designator =
    airline !== undefined && fn !== undefined
      ? `${airline}${fn}`
      : fn;
  const bits = [designator, route].filter(
    (x): x is string => x !== undefined && x.length > 0,
  );
  return bits.length > 0 ? bits.join(" ") : undefined;
}

function formatDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "string" && details.trim().length > 0) {
    return details;
  }
  if (typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    const issues = record["issues"];
    if (typeof issues === "string" && issues.trim().length > 0) {
      return issues;
    }
    const candidates = record["candidates"];
    if (Array.isArray(candidates) && candidates.length > 0) {
      const labels = candidates
        .map(formatCandidate)
        .filter((x): x is string => x !== undefined);
      if (labels.length > 0) {
        return `candidates: ${labels.join("; ")}`;
      }
    }
  }
  return undefined;
}

/** Human-readable message for UI surfaces. */
export function formatApiError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const id =
      error.requestId !== undefined ? ` (request ${error.requestId})` : "";
    const details = formatDetails(error.body?.details);
    const detailSuffix =
      details !== undefined && !error.message.includes(details)
        ? `: ${details}`
        : "";
    return `${error.message}${detailSuffix}${id}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong";
}

export function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof ApiClientError) {
    return error.status === 401 || error.type === "Unauthorized";
  }
  return false;
}
