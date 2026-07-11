/**
 * @tripplan/web — library re-exports (app entry is main.tsx).
 */
export { App, type AppProps } from "./App.tsx";
export { loadConfig, type AppConfig } from "./config.ts";
export const WEB_PACKAGE = "@tripplan/web" as const;
