import { Effect, Layer } from "effect";
import { CurrentOwner } from "./auth/current-owner.js";
import { OwnerAuth, type OwnerAuthService } from "./auth/owner-auth.js";
import {
  makeShareAuthStub,
  ShareAuth,
  SHARE_COOKIE_NAME,
  type ShareAuthService,
} from "./auth/share-auth.js";
import type { ApiConfig } from "./config.js";
import {
  makeInMemoryEnrichBudget,
  DEFAULT_LIVE_FLIGHT_LOOKUP_COST_USD,
} from "./enrichment/budget.js";
import { createFlightProvider } from "./enrichment/create-flight-provider.js";
import { createPlaceProvider } from "./enrichment/create-place-provider.js";
import {
  FlightProviderService,
  type FlightProvider,
} from "./enrichment/flight-provider.js";
import {
  EnrichmentGuards,
  type EnrichmentGuardsService,
} from "./enrichment/guards.js";
import {
  makeInMemoryEnrichRateLimiter,
  DEFAULT_ENRICH_RATE_LIMIT_PER_HOUR,
} from "./enrichment/rate-limit.js";
import { makeMockFlightProvider } from "./enrichment/mock-flight-provider.js";
import { makeMockPlaceProvider } from "./enrichment/mock-place-provider.js";
import {
  PlaceProviderService,
  type PlaceProvider,
} from "./enrichment/place-provider.js";
import {
  AppError,
  appErrorToHttpResponse,
  unexpectedToAppError,
} from "./errors/app-error.js";
import { matchPath } from "./http/path-match.js";
import { RequestContext } from "./http/request-context.js";
import type {
  AuthClass,
  HttpRequest,
  HttpResponse,
} from "./http/types.js";
import type { Logger } from "./logging/logger.js";
import { consoleLogger } from "./logging/logger.js";
import { TripRepo, type TripRepository } from "./repos/trip-repo.js";
import { UserRepo, type UserRepository } from "./repos/user-repo.js";
import { handleEnrichFlight, handleEnrichPlace } from "./routes/enrich.js";
import { handleHealth } from "./routes/health.js";
import { handleMe } from "./routes/me.js";
import {
  handleCreateItem,
  handleDeleteItem,
  handlePatchItem,
  handleReorderItems,
} from "./routes/items.js";
import {
  handleCreateTrip,
  handleExportTrip,
  handleGetTrip,
  handleListTrips,
  handlePatchTrip,
  makeDeleteTripHandler,
} from "./routes/trips.js";

/** Services a route handler may require. */
export type RouteHandlerEnv =
  | OwnerAuth
  | ShareAuth
  | UserRepo
  | TripRepo
  | RequestContext
  | CurrentOwner
  | FlightProviderService
  | PlaceProviderService
  | EnrichmentGuards;

export interface RouteDefinition {
  readonly method: string;
  /** Path pattern with optional `:param` segments. */
  readonly path: string;
  readonly authClass: AuthClass;
  readonly handler: () => Effect.Effect<HttpResponse, AppError, RouteHandlerEnv>;
}

/**
 * Build the route table. Delete respects `tripsDeleteEnabled`.
 */
export function buildRoutes(
  config: Pick<ApiConfig, "tripsDeleteEnabled"> = {
    tripsDeleteEnabled: true,
  },
): readonly RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/v1/health",
      authClass: "public",
      handler: handleHealth,
    },
    {
      method: "GET",
      path: "/api/v1/me",
      authClass: "owner",
      handler: handleMe,
    },
    {
      method: "POST",
      path: "/api/v1/trips",
      authClass: "owner",
      handler: handleCreateTrip,
    },
    {
      method: "GET",
      path: "/api/v1/trips",
      authClass: "owner",
      handler: handleListTrips,
    },
    {
      method: "GET",
      path: "/api/v1/trips/:tripId/export",
      authClass: "owner",
      handler: handleExportTrip,
    },
    // Item routes before bare :tripId only where path length differs;
    // reorder is a static leaf under /items.
    {
      method: "POST",
      path: "/api/v1/trips/:tripId/items/reorder",
      authClass: "owner",
      handler: handleReorderItems,
    },
    {
      method: "POST",
      path: "/api/v1/trips/:tripId/items",
      authClass: "owner",
      handler: handleCreateItem,
    },
    {
      method: "PATCH",
      path: "/api/v1/trips/:tripId/items/:itemId",
      authClass: "owner",
      handler: handlePatchItem,
    },
    {
      method: "DELETE",
      path: "/api/v1/trips/:tripId/items/:itemId",
      authClass: "owner",
      handler: handleDeleteItem,
    },
    {
      method: "GET",
      path: "/api/v1/trips/:tripId",
      authClass: "owner",
      handler: handleGetTrip,
    },
    {
      method: "PATCH",
      path: "/api/v1/trips/:tripId",
      authClass: "owner",
      handler: handlePatchTrip,
    },
    {
      method: "DELETE",
      path: "/api/v1/trips/:tripId",
      authClass: "owner",
      handler: makeDeleteTripHandler(config),
    },
    {
      method: "POST",
      path: "/api/v1/enrich/flight",
      authClass: "owner",
      handler: handleEnrichFlight,
    },
    {
      method: "POST",
      path: "/api/v1/enrich/place",
      authClass: "owner",
      handler: handleEnrichPlace,
    },
  ];
}

/** Default routes (delete enabled) — used by unit tests and static inspection. */
export const routes: readonly RouteDefinition[] = buildRoutes();

export interface RouterDeps {
  readonly ownerAuth: OwnerAuthService;
  readonly userRepo: UserRepository;
  readonly tripRepo: TripRepository;
  readonly shareAuth?: ShareAuthService;
  readonly logger?: Logger;
  readonly routes?: readonly RouteDefinition[];
  /** Defaults to MockFlightProvider when omitted. */
  readonly flightProvider?: FlightProvider;
  /** Defaults to MockPlaceProvider when omitted. */
  readonly placeProvider?: PlaceProvider;
  /** Defaults to permissive in-memory guards when omitted. */
  readonly enrichmentGuards?: EnrichmentGuardsService;
}

/** Default estimated USD for a live MapTiler place lookup. */
export const DEFAULT_LIVE_PLACE_LOOKUP_COST_USD = 0.005;

/** Default enrichment guards for unit tests / local (mock cost 0). */
export function makeDefaultEnrichmentGuards(
  config?: Pick<
    ApiConfig,
    | "enrichmentRateLimitPerHour"
    | "enrichmentMonthlyBudgetUsd"
    | "enrichmentLiveFlightCostUsd"
    | "enrichmentLivePlaceCostUsd"
  >,
): EnrichmentGuardsService {
  return {
    rateLimiter: makeInMemoryEnrichRateLimiter(
      config?.enrichmentRateLimitPerHour ?? DEFAULT_ENRICH_RATE_LIMIT_PER_HOUR,
    ),
    budget: makeInMemoryEnrichBudget(
      config?.enrichmentMonthlyBudgetUsd ?? 25,
    ),
    liveLookupCostUsd:
      config?.enrichmentLiveFlightCostUsd ?? DEFAULT_LIVE_FLIGHT_LOOKUP_COST_USD,
    livePlaceLookupCostUsd:
      config?.enrichmentLivePlaceCostUsd ?? DEFAULT_LIVE_PLACE_LOOKUP_COST_USD,
  };
}

/**
 * Build flight/place providers + guards from full API config (Lambda wiring).
 */
export function makeEnrichmentRuntime(config: ApiConfig): {
  readonly flightProvider: FlightProvider;
  readonly placeProvider: PlaceProvider;
  readonly enrichmentGuards: EnrichmentGuardsService;
} {
  return {
    flightProvider: createFlightProvider(config),
    placeProvider: createPlaceProvider(config),
    enrichmentGuards: makeDefaultEnrichmentGuards(config),
  };
}

interface MatchedRoute {
  readonly route: RouteDefinition;
  readonly pathParams: Readonly<Record<string, string>>;
}

function findRoute(
  method: string,
  path: string,
  routeTable: readonly RouteDefinition[],
): MatchedRoute | undefined {
  for (const route of routeTable) {
    if (route.method !== method) {
      continue;
    }
    const matched = matchPath(route.path, path);
    if (matched !== undefined) {
      return { route, pathParams: matched.params };
    }
  }
  return undefined;
}

function pathPatternMatches(
  pattern: string,
  path: string,
): boolean {
  return matchPath(pattern, path) !== undefined;
}

/**
 * Dispatch a single HTTP request through the authz matrix + route handlers.
 * Owner/share credentials are verified **once** in the gate; handlers read
 * `CurrentOwner` (or future share principal) rather than re-verifying.
 */
export function handleRequest(
  request: HttpRequest,
  deps: RouterDeps,
): Effect.Effect<HttpResponse> {
  const logger = deps.logger ?? consoleLogger;
  const started = Date.now();
  const routeTable = deps.routes ?? routes;

  const matched = findRoute(request.method, request.path, routeTable);

  if (matched === undefined) {
    const pathMatches = routeTable.filter((r) =>
      pathPatternMatches(r.path, request.path),
    );
    if (pathMatches.length > 0) {
      const allow = [...new Set(pathMatches.map((r) => r.method))].join(", ");
      const response = methodNotAllowed(request.requestId, allow);
      logger.request({
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        authClass: pathMatches[0]?.authClass ?? "public",
        status: response.status,
        durationMs: Date.now() - started,
      });
      return Effect.succeed(response);
    }

    const response = appErrorToHttpResponse(
      AppError.notFound(`No route for ${request.method} ${request.path}`),
      request.requestId,
    );
    logger.request({
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      authClass: "public",
      status: response.status,
      durationMs: Date.now() - started,
    });
    return Effect.succeed(response);
  }

  const { route, pathParams } = matched;

  const shareAuth: ShareAuthService =
    deps.shareAuth ??
    makeShareAuthStub(() => request.cookies[SHARE_COOKIE_NAME]);

  const flightProvider = deps.flightProvider ?? makeMockFlightProvider();
  const placeProvider = deps.placeProvider ?? makeMockPlaceProvider();
  const enrichmentGuards =
    deps.enrichmentGuards ?? makeDefaultEnrichmentGuards();

  const requestLayer = Layer.succeed(RequestContext, {
    request,
    authClass: route.authClass,
    pathParams,
  });
  const ownerLayer = Layer.succeed(OwnerAuth, deps.ownerAuth);
  const shareLayer = Layer.succeed(ShareAuth, shareAuth);
  const userLayer = Layer.succeed(UserRepo, deps.userRepo);
  const tripLayer = Layer.succeed(TripRepo, deps.tripRepo);
  const flightLayer = Layer.succeed(FlightProviderService, flightProvider);
  const placeLayer = Layer.succeed(PlaceProviderService, placeProvider);
  const enrichGuardsLayer = Layer.succeed(EnrichmentGuards, enrichmentGuards);
  const appLayer = Layer.mergeAll(
    requestLayer,
    ownerLayer,
    shareLayer,
    userLayer,
    tripLayer,
    flightLayer,
    placeLayer,
    enrichGuardsLayer,
  );

  type CoreEnv =
    | OwnerAuth
    | ShareAuth
    | UserRepo
    | TripRepo
    | RequestContext
    | FlightProviderService
    | PlaceProviderService
    | EnrichmentGuards;

  const program = Effect.gen(function* () {
    // Auth class gate: verify once, inject principal for the handler.
    if (route.authClass === "owner") {
      const auth = yield* OwnerAuth;
      const principal = yield* auth.requireOwner();
      const ownerHandler: Effect.Effect<HttpResponse, AppError, RouteHandlerEnv> =
        route.handler();
      return yield* ownerHandler.pipe(
        Effect.provideService(CurrentOwner, principal),
      );
    }
    if (route.authClass === "share") {
      const auth = yield* ShareAuth;
      yield* auth.requireShare();
    }
    // Public / share handlers do not read CurrentOwner.
    const coreHandler = route.handler() as Effect.Effect<
      HttpResponse,
      AppError,
      CoreEnv
    >;
    return yield* coreHandler;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed(appErrorToHttpResponse(error, request.requestId)),
    ),
    Effect.catchAllDefect((defect) =>
      Effect.succeed(
        appErrorToHttpResponse(
          unexpectedToAppError(defect),
          request.requestId,
        ),
      ),
    ),
    Effect.provide(appLayer),
  );
  return program.pipe(
    Effect.tap((response) =>
      Effect.sync(() => {
        logger.request({
          requestId: request.requestId,
          method: request.method,
          path: request.path,
          authClass: route.authClass,
          status: response.status,
          durationMs: Date.now() - started,
        });
      }),
    ),
  );
}

/** Convenience for non-Effect callers (Lambda). */
export async function handleRequestAsync(
  request: HttpRequest,
  deps: RouterDeps,
): Promise<HttpResponse> {
  return Effect.runPromise(handleRequest(request, deps));
}

/**
 * HTTP 405 with domain type MethodNotAllowed (maps 1:1 via ErrorHttpStatus).
 * ValidationError is reserved for 400 request-body/query validation only.
 */
export function methodNotAllowed(
  requestId: string,
  allow: string,
): HttpResponse {
  const base = appErrorToHttpResponse(AppError.methodNotAllowed(), requestId);
  return {
    ...base,
    headers: {
      ...base.headers,
      allow,
    },
  };
}
