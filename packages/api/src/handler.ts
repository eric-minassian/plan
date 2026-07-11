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
import type { FlightProvider } from "./enrichment/flight-provider.js";
import type { EnrichmentGuardsService } from "./enrichment/guards.js";
import { fromApiGatewayEvent, toApiGatewayResult } from "./http/apigw.js";
import type { HttpRequest } from "./http/types.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import {
  buildRoutes,
  handleRequestAsync,
  makeEnrichmentRuntime,
  type RouterDeps,
} from "./router.js";
import {
  makeInMemoryAttachmentRepo,
  type AttachmentRepository,
} from "./repos/attachment-repo.js";
import { makeDynamoAttachmentRepo } from "./repos/dynamo-attachment-repo.js";
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
import {
  makeMockDocsStore,
  makeS3DocsStore,
  type DocsStoreService,
} from "./s3/docs-store.js";

export interface HandlerOptions {
  readonly config?: ApiConfig;
  readonly ownerAuth?: OwnerAuthService;
  readonly userRepo?: UserRepository;
  readonly tripRepo?: TripRepository;
  readonly shareRepo?: ShareRepository;
  readonly attachmentRepo?: AttachmentRepository;
  readonly docsStore?: DocsStoreService;
  readonly logger?: Logger;
  readonly flightProvider?: FlightProvider;
  readonly enrichmentGuards?: EnrichmentGuardsService;
}

/**
 * Create a Lambda handler for API Gateway HTTP API (payload v2).
 * Owner JWT is verified in-process (no Cognito / APIGW JWT authorizer).
 *
 * Persistence: when `TABLE_NAME` is set, trips + shares + attachments use
 * DynamoDB single-table; otherwise in-memory (unit tests / local skeleton).
 * Documents: `DOCS_BUCKET_NAME` → real S3; otherwise in-memory mock.
 * User profiles remain in-memory until a Dynamo UserRepository lands.
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
  const attachmentRepo =
    options.attachmentRepo ??
    (useDynamo && tableName !== undefined
      ? makeDynamoAttachmentRepo(tableName)
      : makeInMemoryAttachmentRepo());
  const docsBucketName = config.docsBucketName;
  const docsStore =
    options.docsStore ??
    (docsBucketName !== undefined && docsBucketName.length > 0
      ? makeS3DocsStore({
          bucketName: docsBucketName,
          region: config.awsRegion,
        })
      : makeMockDocsStore());

  const routeTable = buildRoutes(config);
  const enrichmentRuntime = makeEnrichmentRuntime(config);
  const flightProvider =
    options.flightProvider ?? enrichmentRuntime.flightProvider;
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
      attachmentRepo,
      docsStore,
      shareAuth,
      logger,
      routes: routeTable,
      flightProvider,
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
