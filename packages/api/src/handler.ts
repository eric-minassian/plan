import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { makeEricminassianOwnerAuth } from "./auth/ericminassian-owner-auth.js";
import type { OwnerAuthService } from "./auth/owner-auth.js";
import { loadConfig, type ApiConfig } from "./config.js";
import type { FlightProvider } from "./enrichment/flight-provider.js";
import type { EnrichmentGuardsService } from "./enrichment/guards.js";
import type { PlaceProvider } from "./enrichment/place-provider.js";
import { fromApiGatewayEvent, toApiGatewayResult } from "./http/apigw.js";
import type { HttpRequest } from "./http/types.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import {
  buildRoutes,
  handleRequestAsync,
  makeEnrichmentRuntime,
  type RouterDeps,
} from "./router.js";
import { makeDynamoTripRepo } from "./repos/dynamo-trip-repo.js";
import {
  makeInMemoryTripRepo,
  type TripRepository,
} from "./repos/trip-repo.js";
import {
  makeInMemoryUserRepo,
  type UserRepository,
} from "./repos/user-repo.js";

export interface HandlerOptions {
  readonly config?: ApiConfig;
  readonly ownerAuth?: OwnerAuthService;
  readonly userRepo?: UserRepository;
  readonly tripRepo?: TripRepository;
  readonly logger?: Logger;
  readonly flightProvider?: FlightProvider;
  readonly placeProvider?: PlaceProvider;
  readonly enrichmentGuards?: EnrichmentGuardsService;
}

/**
 * Create a Lambda handler for API Gateway HTTP API (payload v2).
 * Owner JWT is verified in-process (no Cognito / APIGW JWT authorizer).
 *
 * Persistence: when `TABLE_NAME` is set, trips use DynamoDB single-table;
 * otherwise in-memory (unit tests / local skeleton). User profiles remain
 * in-memory until a Dynamo UserRepository lands.
 */
export function createHandler(
  options: HandlerOptions = {},
): APIGatewayProxyHandlerV2 {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? consoleLogger;
  const userRepo = options.userRepo ?? makeInMemoryUserRepo();
  const tripRepo =
    options.tripRepo ??
    (config.tableName !== undefined && config.tableName.length > 0
      ? makeDynamoTripRepo(config.tableName)
      : makeInMemoryTripRepo());

  const routeTable = buildRoutes(config);
  const enrichmentRuntime = makeEnrichmentRuntime(config);
  const flightProvider =
    options.flightProvider ?? enrichmentRuntime.flightProvider;
  const placeProvider =
    options.placeProvider ?? enrichmentRuntime.placeProvider;
  const enrichmentGuards =
    options.enrichmentGuards ?? enrichmentRuntime.enrichmentGuards;

  // Mutable request holder so OwnerAuth can read the active request for DPoP.
  let currentRequest: HttpRequest | undefined;

  const ownerAuth: OwnerAuthService =
    options.ownerAuth ??
    makeEricminassianOwnerAuth(
      config,
      () => {
        if (currentRequest === undefined) {
          throw new Error("OwnerAuth invoked without an active request");
        }
        return currentRequest;
      },
      undefined,
      logger,
    );

  return async (
    event: APIGatewayProxyEventV2,
    _context: Context,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const request = fromApiGatewayEvent(event, {
      publicApiBaseUrl: config.publicApiBaseUrl,
    });
    currentRequest = request;

    const deps: RouterDeps = {
      ownerAuth,
      userRepo,
      tripRepo,
      logger,
      routes: routeTable,
      flightProvider,
      placeProvider,
      enrichmentGuards,
    };

    try {
      const response = await handleRequestAsync(request, deps);
      return toApiGatewayResult(response);
    } finally {
      currentRequest = undefined;
    }
  };
}

/** Default Lambda entry used by ApiStack bundling. */
export const handler: APIGatewayProxyHandlerV2 = createHandler();
