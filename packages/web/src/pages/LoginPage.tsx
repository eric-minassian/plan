import { useAuth } from "@ericminassian/auth/react";

/** Unauthenticated landing — CTA to start PKCE login at auth.ericminassian.com. */
export function LoginPage() {
  const { signIn } = useAuth();

  return (
    <div className="panel login">
      <h2 className="login__title">Welcome to TripPlan</h2>
      <p className="muted">
        Sign in with your passkey to list and create trips.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          void signIn({ returnTo: "/" });
        }}
      >
        Sign in
      </button>
    </div>
  );
}
