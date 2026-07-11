import {
  createAuthClient,
  type AuthClient,
} from "@ericminassian/auth/client";
import type { AppConfig } from "../config.ts";

/**
 * Browser OIDC client for the `plan` public client.
 * Access tokens stay in memory; refresh tokens in sessionStorage (SDK default).
 *
 * Call once per app load and pass the same instance to both `AuthProvider` and
 * `AuthClientProvider` — never construct a second client for the same session.
 */
export function createWebAuthClient(config: AppConfig): AuthClient {
  return createAuthClient({
    clientId: config.authClientId,
    issuer: config.authIssuer,
    redirectUri: `${window.location.origin}/auth/callback`,
  });
}
