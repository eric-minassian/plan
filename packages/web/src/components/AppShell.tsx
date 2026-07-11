import { useAuth, useUser } from "@ericminassian/auth/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function AppShell(props: { readonly children: ReactNode }) {
  const { state, signOut } = useAuth();
  const user = useUser();
  const label = user?.nickname ?? user?.sub;

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          <Link to="/" className="shell__title-link">
            <h1 className="shell__title">TripPlan</h1>
          </Link>
          <p className="shell__subtitle">Plan trips. Share cleanly.</p>
        </div>
        <div className="shell__actions">
          {state.status === "authenticated" ? (
            <>
              {label !== undefined ? (
                <span className="shell__user" title={user?.sub}>
                  {label}
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void signOut({
                    postLogoutRedirectUri: window.location.origin,
                  });
                }}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main className="shell__main">{props.children}</main>
    </div>
  );
}
