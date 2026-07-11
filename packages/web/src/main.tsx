import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadConfig } from "./config.ts";
import { registerServiceWorker } from "./pwa/register-sw.ts";
import "./index.css";

async function bootstrap(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error('Missing #root element in index.html');
  }

  const root = createRoot(rootElement);

  try {
    const config = await loadConfig();
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
    registerServiceWorker();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start TripPlan";
    root.render(
      <div className="shell shell--error">
        <h1>TripPlan</h1>
        <p>Could not load runtime config.</p>
        <pre>{message}</pre>
      </div>,
    );
  }
}

void bootstrap();
