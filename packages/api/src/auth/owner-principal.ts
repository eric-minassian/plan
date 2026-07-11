/**
 * Authenticated owner identity extracted from a verified OIDC access token.
 * Identity is keyed on `sub` (+ issuer); never on nickname.
 */
export interface OwnerPrincipal {
  readonly sub: string;
  readonly iss: string;
  readonly nickname?: string;
  readonly sid?: string;
  readonly scope?: string;
  readonly jti?: string;
  readonly acr?: string;
  /** Remaining verified claims (no email required). */
  readonly claims: Readonly<Record<string, unknown>>;
}
