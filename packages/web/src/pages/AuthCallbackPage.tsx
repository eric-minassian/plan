import { Button } from "@eric-minassian/design/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@eric-minassian/design/components/card";
import { BusyIcon } from "../components/BusyIcon.tsx";
import { AuthError } from "@ericminassian/auth/client";
import { useAuth } from "@ericminassian/auth/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthClient } from "../auth/AuthClientContext.tsx";
import { completeAuthCallback } from "../auth/complete-callback.ts";
import { ErrorAlert } from "../components/ErrorAlert.tsx";

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
      <Card>
        <CardHeader>
          <CardTitle>Sign-in failed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ErrorAlert>{error}</ErrorAlert>
          <Button
            type="button"
            onClick={() => {
              void client.signInWithRedirect({ returnTo: "/" });
            }}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <BusyIcon />
        {state.status === "authenticated"
          ? "Signed in — redirecting…"
          : "Completing sign-in…"}
      </CardContent>
    </Card>
  );
}
