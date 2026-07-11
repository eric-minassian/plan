import { AuthProvider } from "@ericminassian/auth/react";
import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthClientProvider } from "./auth/AuthClientContext.tsx";
import { createWebAuthClient } from "./auth/create-web-auth-client.ts";
import { AppShell } from "./components/AppShell.tsx";
import { ProtectedRoute } from "./components/ProtectedRoute.tsx";
import type { AppConfig } from "./config.ts";
import { AuthCallbackPage } from "./pages/AuthCallbackPage.tsx";
import { TripListPage } from "./pages/TripListPage.tsx";

export interface AppProps {
  readonly config: AppConfig;
}

/** TripPlan SPA root: auth, routing, trip list/create (PR 8a). */
export function App({ config }: AppProps) {
  const authClient = useMemo(() => createWebAuthClient(config), [config]);

  return (
    <AuthClientProvider client={authClient}>
      <AuthProvider client={authClient}>
        <BrowserRouter>
          <AppShell>
            <Routes>
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <TripListPage />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </AuthProvider>
    </AuthClientProvider>
  );
}
