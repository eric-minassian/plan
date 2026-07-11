import type { AuthClient } from "@ericminassian/auth/client";
import { createContext, useContext, type ReactNode } from "react";

const AuthClientContext = createContext<AuthClient | undefined>(undefined);

/**
 * Exposes the same {@link AuthClient} instance used by `AuthProvider`.
 *
 * There must be exactly one client per app bootstrap (`createWebAuthClient`
 * once in `App`). `useAuth()` does not expose `fetchWithAuth` / DPoP, so this
 * context shares that single client with the API layer.
 */
export function AuthClientProvider(props: {
  readonly client: AuthClient;
  readonly children: ReactNode;
}) {
  return (
    <AuthClientContext.Provider value={props.client}>
      {props.children}
    </AuthClientContext.Provider>
  );
}

/** The underlying {@link AuthClient} (for `fetchWithAuth` / DPoP). */
export function useAuthClient(): AuthClient {
  const client = useContext(AuthClientContext);
  if (client === undefined) {
    throw new Error("useAuthClient must be used within AuthClientProvider");
  }
  return client;
}
