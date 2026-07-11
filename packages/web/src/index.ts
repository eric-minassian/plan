/**
 * @tripplan/web — library re-exports (app entry is main.tsx).
 */
export { App, type AppProps } from "./App.tsx";
export { loadConfig, type AppConfig } from "./config.ts";
export {
  createTripPlanApi,
  apiUrl,
  type TripPlanApi,
  type TripPlanApiOptions,
  type TripListResponse,
} from "./api/client.ts";
export {
  ApiClientError,
  formatApiError,
  parseApiErrorBody,
  isUnauthorizedError,
} from "./api/errors.ts";
export {
  decodeCreateTrip,
  decodeTripListResponse,
  decodeTripResponse,
} from "./api/decode.ts";
export const WEB_PACKAGE = "@tripplan/web" as const;
