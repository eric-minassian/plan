import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  getHeader,
  parseCookies,
  type HttpRequest,
  type HttpResponse,
} from "./types.js";

export interface FromApiGatewayOptions {
  /**
   * Trusted public origin for DPoP `htu` (e.g. `https://plan.ericminassian.com`).
   * When set, path/query are appended to this base and client `X-Forwarded-*` is ignored.
   */
  readonly publicApiBaseUrl?: string;
}

/**
 * Map API Gateway HTTP API (payload format 2.0) → internal HttpRequest.
 */
export function fromApiGatewayEvent(
  event: APIGatewayProxyEventV2,
  options: FromApiGatewayOptions = {},
): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }

  const cookiesFromEvent: Record<string, string> = {};
  for (const raw of event.cookies ?? []) {
    const eq = raw.indexOf("=");
    if (eq > 0) {
      cookiesFromEvent[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
  }
  const cookieHeader = getHeader(headers, "cookie");
  const cookies = {
    ...parseCookies(cookieHeader),
    ...cookiesFromEvent,
  };

  const query: Record<string, string | undefined> = {
    ...(event.queryStringParameters ?? {}),
  };

  const method = (event.requestContext.http.method ?? "GET").toUpperCase();
  // rawPath is the request path without stage prefix for HTTP API.
  const path = normalizePath(
    event.rawPath ?? event.requestContext.http.path ?? "/",
  );
  const url = buildAbsoluteUrl(event, path, options.publicApiBaseUrl);
  const requestId =
    event.requestContext.requestId ??
    event.headers?.["x-request-id"] ??
    crypto.randomUUID();

  let body = event.body;
  if (body !== undefined && event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  const clientIp =
    event.requestContext.http.sourceIp !== undefined &&
    event.requestContext.http.sourceIp.length > 0
      ? event.requestContext.http.sourceIp
      : "unknown";

  return {
    method,
    path,
    url,
    headers,
    query,
    cookies,
    body,
    requestId,
    clientIp,
  };
}

export function toApiGatewayResult(
  response: HttpResponse,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.status,
    headers: response.headers as Record<string, string> | undefined,
    cookies:
      response.cookies !== undefined && response.cookies.length > 0
        ? [...response.cookies]
        : undefined,
    body: response.body,
  };
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path.length === 0 ? "/" : path;
}

/**
 * Absolute URL for DPoP `htu` binding.
 *
 * Precedence:
 * 1. Configured `publicApiBaseUrl` (trusted, set by ApiStack for prod SPA host)
 * 2. `Host` header (API Gateway / edge-set) + `X-Forwarded-Proto` (default https)
 * 3. `requestContext.domainName`
 *
 * Deliberately does **not** prefer client-controlled `X-Forwarded-Host`.
 */
export function buildAbsoluteUrl(
  event: APIGatewayProxyEventV2,
  path: string,
  publicApiBaseUrl?: string,
): string {
  const rawQuery = event.rawQueryString;
  const qs =
    rawQuery !== undefined && rawQuery.length > 0 ? `?${rawQuery}` : "";

  if (publicApiBaseUrl !== undefined && publicApiBaseUrl.length > 0) {
    const base = publicApiBaseUrl.replace(/\/$/, "");
    return `${base}${path}${qs}`;
  }

  const headers = event.headers ?? {};
  // Prefer Host over X-Forwarded-Host (untrusted from clients until CF overwrites).
  const host =
    headerCI(headers, "host") ??
    event.requestContext.domainName ??
    "localhost";
  const proto = headerCI(headers, "x-forwarded-proto") ?? "https";
  return `${proto}://${host}${path}${qs}`;
}

function headerCI(
  headers: Record<string, string | undefined>,
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
