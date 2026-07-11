/**
 * Registers the production service worker (vite-plugin-pwa).
 *
 * No-op outside production builds so local Vite HMR is unaffected.
 * `registerType: autoUpdate` refreshes the SW when a new build is deployed.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) {
    return;
  }
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  void import("virtual:pwa-register")
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onRegisteredSW(_swUrl, registration) {
          if (registration === undefined) {
            return;
          }
          // Periodic update check (CloudFront may serve a long-cached sw.js).
          // SPA lifetime — no unmount; interval is intentional.
          const intervalMs = 60 * 60 * 1000;
          window.setInterval(() => {
            void registration.update();
          }, intervalMs);
        },
        onRegisterError(error) {
          console.warn("[pwa] service worker registration failed", error);
        },
      });
    })
    .catch((error: unknown) => {
      console.warn("[pwa] failed to load SW registrar", error);
    });
}
