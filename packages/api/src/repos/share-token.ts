import { createHash, randomBytes } from "node:crypto";

/** 256-bit raw capability token (base64url, no padding). */
export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Opaque share session id (base64url). */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** Share grant id with stable prefix. */
export function generateShareId(): string {
  return `shr_${randomBytes(16).toString("hex")}`;
}

/** SHA-256 hex digest of the raw token (stored at rest / GSI2). */
export function hashShareToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function shareTokenGsi2Pk(tokenHash: string): string {
  return `SHARETOKEN#${tokenHash}`;
}

export function shareSk(shareId: string): string {
  return `SHARE#${shareId}`;
}

export function sessionPk(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function sessionSk(): string {
  return "META";
}

export function gsi3PkForTrip(tripId: string): string {
  return `TRIP#${tripId}`;
}

export function gsi3SkForSession(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function gsi4PkForShare(shareId: string): string {
  return `SHARE#${shareId}`;
}

export function gsi4SkForSession(sessionId: string): string {
  return `SESSION#${sessionId}`;
}
