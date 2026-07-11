import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { makeEricminassianOwnerAuth } from "./auth/ericminassian-owner-auth.js";
import type { OwnerAuthService } from "./auth/owner-auth.js";
import { makeShareAuth, SHARE_COOKIE_NAME } from "./auth/share-auth.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { fromApiGatewayEvent, toApiGatewayResult } from "./http/apigw.js";
import type { HttpRequest } from "./http/types.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import {
  buildRoutes,
  handleRequestAsync,
  type RouterDeps,
} from "./router.js";
import { makeDynamoShareRepo } from "./repos/dynamo-share-repo.js";
import { makeDynamoTripRepo } from "./repos/dynamo-trip-repo.js";
import {
  makeInMemoryShareRepo,
  type ShareRepository,
} from "./repos/share-repo.js";
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
  readonly shareRepo?: ShareRepository;
  readonly logger?: Logger;
}

/**
 * Create a Lambda handler for API Gateway HTTP API (payload v2).
 * Owner JWT is verified in-process (no Cognito / APIGW JWT authorizer).
 *
 * Persistence: when `TABLE_NAME` is set, trips + shares use DynamoDB single-table;
 * otherwise in-memory (unit tests / local skeleton). User profiles remain
 * in-memory until a Dynamo UserRepository lands.
 */
export function createHandler(
  options: HandlerOptions = {},
): APIGatewayProxyHandlerV2 {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? consoleLogger;
  const userRepo = options.userRepo ?? makeInMemoryUserRepo();
  const tableName = config.tableName;
  const useDynamo = tableName !== undefined && tableName.length > 0;
  const tripRepo =
    options.tripRepo ??
    (useDynamo && tableName !== undefined
      ? makeDynamoTripRepo(tableName)
      : makeInMemoryTripRepo());
  const shareRepo =
    options.shareRepo ??
    (useDynamo && tableName !== undefined
      ? makeDynamoShareRepo(tableName)
      : makeInMemoryShareRepo());

  const routeTable = buildRoutes(config);

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

    const shareAuth = makeShareAuth({
      getCookie: () => request.cookies[SHARE_COOKIE_NAME],
      shareRepo,
      tripRepo,
    });

    const deps: RouterDeps = {
      ownerAuth,
      userRepo,
      tripRepo,
      shareRepo,
      shareAuth,
      logger,
      routes: routeTable,
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
