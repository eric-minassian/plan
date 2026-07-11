import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { makeEricminassianOwnerAuth } from "./auth/ericminassian-owner-auth.js";
import type { OwnerAuthService } from "./auth/owner-auth.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { fromApiGatewayEvent, toApiGatewayResult } from "./http/apigw.js";
import type { HttpRequest } from "./http/types.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import { handleRequestAsync, type RouterDeps } from "./router.js";
import {
  makeInMemoryUserRepo,
  type UserRepository,
} from "./repos/user-repo.js";

export interface HandlerOptions {
  readonly config?: ApiConfig;
  readonly ownerAuth?: OwnerAuthService;
  readonly userRepo?: UserRepository;
  readonly logger?: Logger;
}

/**
 * Create a Lambda handler for API Gateway HTTP API (payload v2).
 * Owner JWT is verified in-process (no Cognito / APIGW JWT authorizer).
 *
 * Profile store: defaults to process-local in-memory repo (skeleton).
 * `TABLE_NAME` / Dynamo grants are provisioned for the upcoming Dynamo-backed
 * UserRepository — GET /me does not persist across instances yet.
 */
export function createHandler(
  options: HandlerOptions = {},
): APIGatewayProxyHandlerV2 {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? consoleLogger;
  // Interim until DynamoDB UserRepository (USER#sub / PROFILE) lands.
  const userRepo = options.userRepo ?? makeInMemoryUserRepo();

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
      logger,
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
