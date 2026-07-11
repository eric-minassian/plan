import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * Vite SPA config.
 *
 * Local `/api` proxy: set `VITE_API_PROXY_TARGET` to the HTTP API base URL
 * (e.g. `https://{id}.execute-api.us-east-1.amazonaws.com` from ApiStack
 * `HttpApiUrl` output). Defaults to `http://127.0.0.1:3000` for a local mock.
 *
 * Production: CloudFront serves the SPA and proxies `/api/*` to API Gateway
 * (see WebStack) — no Vite proxy in that path.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget =
    env["VITE_API_PROXY_TARGET"]?.trim() || "http://127.0.0.1:3000";

  return {
    plugins: [react(), tailwindcss()],
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
