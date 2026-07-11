import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Vite SPA config.
 *
 * Local `/api` proxy: set `VITE_API_PROXY_TARGET` to the HTTP API base URL
 * (e.g. `https://{id}.execute-api.us-east-1.amazonaws.com` from ApiStack
 * `HttpApiUrl` output). Defaults to `http://127.0.0.1:3000` for a local mock.
 *
 * Production: CloudFront serves the SPA and proxies `/api/*` to API Gateway
 * (see WebStack) — no Vite proxy in that path.
 *
 * PWA (optional / post-GA): service worker precaches the SPA shell. Offline
 * share re-open uses app-level localStorage (not SW Cache Storage for the
 * trip JSON) so online loads never silently succeed with a stale response.
 * Owner-authenticated `/api/*` is never cached.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget =
    env["VITE_API_PROXY_TARGET"]?.trim() || "http://127.0.0.1:3000";

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        // icon.svg is already covered by globPatterns (*.svg); avoid double precache.
        manifest: {
          name: "TripPlan",
          short_name: "TripPlan",
          description: "Modern trip planning — shared itinerary viewer",
          theme_color: "#0f1419",
          background_color: "#0f1419",
          display: "standalone",
          start_url: "/",
          scope: "/",
          icons: [
            {
              src: "/icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        workbox: {
          // SPA shell + static assets only (hashed bundles, index.html, css, etc.).
          globPatterns: ["**/*.{js,css,html,ico,svg,woff2,webmanifest}"],
          // Never put API responses in the precache manifest.
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // Offline shell boot only. No networkTimeoutSeconds — a slow
              // network must not fall back to a week-old authIssuer/clientId.
              // Short maxAge so key rotation is not stuck for days.
              urlPattern: ({ url }) => url.pathname === "/config.json",
              handler: "NetworkFirst",
              options: {
                cacheName: "tripplan-config",
                expiration: {
                  maxEntries: 1,
                  maxAgeSeconds: 60 * 60,
                },
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              // Share trip JSON is offline via app localStorage only.
              // NetworkOnly avoids NetworkFirst+timeout serving revoked/stale
              // trip bodies as a successful online fetch (no offline banner).
              // Workbox registerRoute defaults to GET only; non-GET /api/*
              // bypass the SW (still never written to Cache Storage).
              urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
              handler: "NetworkOnly",
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      emptyOutDir: true,
    },
  };
});
