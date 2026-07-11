import { useAuth } from "@ericminassian/auth/react";
import type { ReactNode } from "react";
import { LoginPage } from "../pages/LoginPage.tsx";

/**
 * Renders children when authenticated; otherwise a login CTA.
 *
 * Note: `@ericminassian/auth@1.1.0` initializes as `authenticated` (stored id
 * token) or `unauthenticated` only — it does not publish a bootstrap `loading`
 * state, so we do not render a "Checking session…" gate.
 */
export function ProtectedRoute(props: { readonly children: ReactNode }) {
  const { state } = useAuth();

  if (state.status !== "authenticated") {
    return <LoginPage />;
  }

  return <>{props.children}</>;
}
