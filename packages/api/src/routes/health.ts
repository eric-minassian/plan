import { Effect } from "effect";
import { jsonResponse, type HttpResponse } from "../http/types.js";

export interface HealthResponse {
  readonly status: "ok";
}

export const healthResponse: HealthResponse = { status: "ok" };

/** GET /api/v1/health — Public; no JWT. */
export function handleHealth(): Effect.Effect<HttpResponse, never> {
  return Effect.succeed(jsonResponse(200, healthResponse));
}
