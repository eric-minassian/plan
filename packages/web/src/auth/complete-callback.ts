import type { AuthClient } from "@ericminassian/auth/client";

export type AuthCallbackResult = {
  readonly returnTo: string | undefined;
} | null;

/**
 * Module-level one-shot for OIDC code exchange.
 *
 * React StrictMode remounts reset component refs but keep this module state,
 * so concurrent / sequential `handleCallback` calls share one promise and
 * do not re-consume a PKCE transaction already removed by the SDK.
 */
let callbackOnce: Promise<AuthCallbackResult> | undefined;

/**
 * Complete the redirect callback exactly once per page load.
 * On failure, recovers with `{ returnTo: undefined }` when the client is already
 * authenticated (spent callback URL / race after a successful exchange).
 */
export function completeAuthCallback(
  client: AuthClient,
): Promise<AuthCallbackResult> {
  if (callbackOnce !== undefined) {
    return callbackOnce;
  }

  callbackOnce = (async (): Promise<AuthCallbackResult> => {
    try {
      return await client.handleCallback();
    } catch (cause) {
      if (client.getState().status === "authenticated") {
        return { returnTo: undefined };
      }
      // Allow a later explicit retry (Try again → new login → new callback URL).
      callbackOnce = undefined;
      throw cause;
    }
  })();

  return callbackOnce;
}

/** Test-only: reset the one-shot lock between cases. */
export function resetAuthCallbackOnceForTests(): void {
  callbackOnce = undefined;
}
