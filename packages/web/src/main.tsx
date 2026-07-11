import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadConfig } from "./config.ts";
import "./index.css";

async function bootstrap(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error("Missing #root element in index.html");
  }

  const root = createRoot(rootElement);

  try {
    const config = await loadConfig();
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start TripPlan";
    root.render(
      <div className="mx-auto max-w-2xl px-4 py-8 text-destructive">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          TripPlan
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Could not load runtime config.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">
          {message}
        </pre>
      </div>,
    );
  }
}

void bootstrap();
