/**
 * Framework-agnostic HTTP request/response shapes used by the router.
 * Lambda APIGW v2 adapter maps events into these types.
 */

export type AuthClass = "public" | "share" | "owner";

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  /** Absolute URL for DPoP htu binding (method + URL). */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly cookies: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly requestId: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): HttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function getHeader(
  headers: Readonly<Record<string, string | undefined>>,
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

export function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (cookieHeader === undefined || cookieHeader.length === 0) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[name] = value;
  }
  return out;
}
