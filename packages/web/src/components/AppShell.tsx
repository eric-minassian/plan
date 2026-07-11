import { Button } from "@eric-minassian/design/components/button";
import { Separator } from "@eric-minassian/design/components/separator";
import { useAuth, useUser } from "@ericminassian/auth/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function AppShell(props: { readonly children: ReactNode }) {
  const { state, signOut } = useAuth();
  const user = useUser();
  const label = user?.nickname ?? user?.sub;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/" className="text-foreground no-underline">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              TripPlan
            </h1>
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan trips. Share cleanly.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.status === "authenticated" ? (
            <>
              {label !== undefined ? (
                <span
                  className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline"
                  title={user?.sub}
                >
                  {label}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void signOut({
                    postLogoutRedirectUri: window.location.origin,
                  });
                }}
              >
                Sign out
              </Button>
            </>
          ) : null}
        </div>
      </header>
      <Separator className="mb-6" />
      <main className="flex flex-1 flex-col gap-5">{props.children}</main>
    </div>
  );
}
