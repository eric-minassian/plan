import type { AppConfig } from "./config.ts";

export interface AppProps {
  readonly config: AppConfig;
}

/** Minimal TripPlan shell — full UI lands in later PRs. */
export function App({ config }: AppProps) {
  return (
    <div className="shell">
      <header className="shell__header">
        <h1 className="shell__title">TripPlan</h1>
        <p className="shell__subtitle">Plan trips. Share cleanly.</p>
      </header>
      <main className="shell__main">
        <p className="shell__status">Empty shell — product UI coming soon.</p>
        <dl className="shell__meta">
          <div>
            <dt>Auth issuer</dt>
            <dd>{config.authIssuer}</dd>
          </div>
          <div>
            <dt>Client ID</dt>
            <dd>{config.authClientId}</dd>
          </div>
          <div>
            <dt>MapTiler key</dt>
            <dd>
              {config.mapTilerApiKey.trim() === ""
                ? "(not configured)"
                : "(configured)"}
            </dd>
          </div>
        </dl>
      </main>
    </div>
  );
}
