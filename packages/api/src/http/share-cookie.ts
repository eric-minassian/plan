import {
  SHARE_COOKIE_NAME,
  SHARE_SESSION_TTL_SECONDS,
} from "@tripplan/domain";

/**
 * Build Set-Cookie value for a new share session.
 * HttpOnly; Secure; SameSite=Lax; Path=/ (single active share session in v1).
 */
export function buildShareSessionCookie(
  sessionId: string,
  maxAgeSeconds: number = SHARE_SESSION_TTL_SECONDS,
): string {
  return [
    `${SHARE_COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${String(maxAgeSeconds)}`,
  ].join("; ");
}

/** Clear the share session cookie. */
export function clearShareSessionCookie(): string {
  return [
    `${SHARE_COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}
