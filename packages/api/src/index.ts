/**
 * @tripplan/api — HTTP routes, authz matrix, repositories, Lambda handler.
 *
 * OpenAPI source of truth: `openapi.yaml` at package root (not duplicated in TS).
 */

export { API_PACKAGE } from "./package-meta.js";

export { loadConfig, type ApiConfig } from "./config.js";
export {
  handler,
  createHandler,
  type HandlerOptions,
} from "./handler.js";
export {
  buildRoutes,
  handleRequest,
  handleRequestAsync,
  routes,
  type RouteDefinition,
  type RouterDeps,
} from "./router.js";
export {
  OwnerAuth,
  type OwnerAuthService,
} from "./auth/owner-auth.js";
export { CurrentOwner } from "./auth/current-owner.js";
export type { OwnerPrincipal } from "./auth/owner-principal.js";
export {
  makeEricminassianOwnerAuth,
  toFetchRequest,
  toOwnerPrincipal,
} from "./auth/ericminassian-owner-auth.js";
export { makeDpopReplayCache } from "./auth/dpop-replay-cache.js";
export {
  makeMockOwnerAuth,
  mockPrincipal,
} from "./auth/mock-owner-auth.js";
export {
  ShareAuth,
  SHARE_COOKIE_NAME,
  makeShareAuth,
  makeShareAuthStub,
  type ShareAuthService,
  type SharePrincipal,
} from "./auth/share-auth.js";
export { CurrentShare } from "./auth/current-share.js";
export { AppError, appErrorToHttpResponse } from "./errors/app-error.js";
export {
  UserRepo,
  makeInMemoryUserRepo,
  type UserRepository,
} from "./repos/user-repo.js";
export {
  TripRepo,
  makeInMemoryTripRepo,
  MAX_ACTIVE_TRIPS_PER_OWNER,
  TRIP_LIST_PAGE_SIZE,
  type TripRepository,
  type ListTripsResult,
} from "./repos/trip-repo.js";
export { makeDynamoTripRepo } from "./repos/dynamo-trip-repo.js";
export {
  ShareRepo,
  makeInMemoryShareRepo,
  type ShareRepository,
} from "./repos/share-repo.js";
export { makeDynamoShareRepo } from "./repos/dynamo-share-repo.js";
export {
  AttachmentRepo,
  makeInMemoryAttachmentRepo,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_PENDING_ATTACHMENTS_PER_ITEM,
  type AttachmentRepository,
} from "./repos/attachment-repo.js";
export { makeDynamoAttachmentRepo } from "./repos/dynamo-attachment-repo.js";
export {
  DocsStore,
  createDocsS3Client,
  makeMockDocsStore,
  makeS3DocsStore,
  PENDING_OBJECT_TAG,
  PRESIGN_PUT_SIGNED_HEADER_NAMES,
  type DocsStoreService,
  type MockDocsStore,
} from "./s3/docs-store.js";
export {
  TripDeleteQueue,
  makeInMemoryTripDeleteQueue,
  makeSqsTripDeleteQueue,
  parseTripDeleteMessage,
  serializeTripDeleteMessage,
  type TripDeleteMessage,
  type TripDeleteQueueService,
  type InMemoryTripDeleteQueue,
} from "./sqs/trip-delete-queue.js";
export {
  createTripDeleteWorkerHandler,
  runTripDeleteCascade,
  handler as tripDeleteWorkerHandler,
} from "./workers/trip-delete-worker.js";
export type {
  AuthClass,
  HttpRequest,
  HttpResponse,
} from "./http/types.js";
export {
  fromApiGatewayEvent,
  toApiGatewayResult,
  buildAbsoluteUrl,
} from "./http/apigw.js";
export { healthResponse, type HealthResponse } from "./routes/health.js";
