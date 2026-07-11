import { AuthError } from "@ericminassian/auth/client";
import { useAuth } from "@ericminassian/auth/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthClient } from "../auth/AuthClientContext.tsx";
import { completeAuthCallback } from "../auth/complete-callback.ts";

/**
 * Completes the Authorization Code + PKCE redirect.
 * Uses module-level {@link completeAuthCallback} so StrictMode remounts do not
 * double-exchange the authorization code.
 */
export function AuthCallbackPage() {
  const client = useAuthClient();
  const { state } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await completeAuthCallback(client);
        if (cancelled) {
          return;
        }
        if (result === null) {
          // Silent auth iframe — parent already has the result; do nothing.
          return;
        }
        const target =
          result.returnTo !== undefined && result.returnTo.length > 0
            ? result.returnTo
            : "/";
        // Prefer in-app navigation when returnTo is same-origin path.
        try {
          const url = new URL(target, window.location.origin);
          if (url.origin === window.location.origin) {
            navigate(`${url.pathname}${url.search}${url.hash}`, {
              replace: true,
            });
            return;
          }
        } catch {
          // fall through to home
        }
        navigate("/", { replace: true });
      } catch (cause) {
        if (cancelled) {
          return;
        }
        const message =
          cause instanceof AuthError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "Sign-in failed";
        setError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, navigate]);

  if (error !== undefined) {
    return (
      <div className="panel panel--error">
        <h2>Sign-in failed</h2>
        <p>{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            void client.signInWithRedirect({ returnTo: "/" });
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <p className="muted">
        {state.status === "authenticated"
          ? "Signed in — redirecting…"
          : "Completing sign-in…"}
      </p>
    </div>
  );
}
