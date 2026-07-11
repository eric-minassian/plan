import { Effect, Layer } from "effect";
import { CurrentOwner } from "./auth/current-owner.js";
import { CurrentShare } from "./auth/current-share.js";
import { OwnerAuth, type OwnerAuthService } from "./auth/owner-auth.js";
import {
  makeShareAuth,
  ShareAuth,
  SHARE_COOKIE_NAME,
  type ShareAuthService,
} from "./auth/share-auth.js";
import type { ApiConfig } from "./config.js";
import {
  AppError,
  appErrorToHttpResponse,
  unexpectedToAppError,
} from "./errors/app-error.js";
import { matchPath } from "./http/path-match.js";
import { makeShareSessionRateLimiter } from "./http/rate-limit.js";
import { RequestContext } from "./http/request-context.js";
import type {
  AuthClass,
  HttpRequest,
  HttpResponse,
} from "./http/types.js";
import type { Logger } from "./logging/logger.js";
import { consoleLogger } from "./logging/logger.js";
import {
  AttachmentRepo,
  makeInMemoryAttachmentRepo,
  type AttachmentRepository,
} from "./repos/attachment-repo.js";
import { ShareRepo, type ShareRepository } from "./repos/share-repo.js";
import { TripRepo, type TripRepository } from "./repos/trip-repo.js";
import { UserRepo, type UserRepository } from "./repos/user-repo.js";
import {
  DocsStore,
  makeMockDocsStore,
  type DocsStoreService,
} from "./s3/docs-store.js";
import {
  handleConfirmAttachment,
  handleDeleteAttachment,
  handleListAttachments,
  handleOwnerAttachmentUrl,
  handlePresignAttachment,
  handleShareAttachmentUrl,
} from "./routes/attachments.js";
import { handleHealth } from "./routes/health.js";
import { handleDeleteMe, handleMe } from "./routes/me.js";
import {
  makeInMemoryTripDeleteQueue,
  TripDeleteQueue,
  type TripDeleteQueueService,
} from "./sqs/trip-delete-queue.js";
import {
  handleCreateItem,
  handleDeleteItem,
  handlePatchItem,
  handleReorderItems,
} from "./routes/items.js";
import {
  handleCreateShare,
  handleCreateShareSession,
  handleDeleteShareSession,
  handleGetShareTrip,
  handleListShares,
  handleRevokeShare,
} from "./routes/shares.js";
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
  | ShareRepo
  | AttachmentRepo
  | DocsStore
  | TripDeleteQueue
  | RequestContext
  | CurrentOwner
  | CurrentShare;

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
  config: {
    readonly tripsDeleteEnabled?: boolean;
    readonly shareAllowedOrigins?: readonly string[];
  } = {},
  rateLimiter = makeShareSessionRateLimiter(),
): readonly RouteDefinition[] {
  const tripsDeleteEnabled = config.tripsDeleteEnabled ?? true;
  const shareAllowedOrigins = config.shareAllowedOrigins ?? [];
  const deleteConfig: Pick<ApiConfig, "tripsDeleteEnabled"> = {
    tripsDeleteEnabled,
  };
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
      method: "DELETE",
      path: "/api/v1/me",
      authClass: "owner",
      handler: handleDeleteMe,
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
    // Share management (owner) before bare :tripId
    {
      method: "POST",
      path: "/api/v1/trips/:tripId/shares",
      authClass: "owner",
      handler: handleCreateShare,
    },
    {
      method: "GET",
      path: "/api/v1/trips/:tripId/shares",
      authClass: "owner",
      handler: handleListShares,
    },
    {
      method: "DELETE",
      path: "/api/v1/trips/:tripId/shares/:shareId",
      authClass: "owner",
      handler: handleRevokeShare,
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
    // Attachment routes (static leaves before :attachmentId)
    {
      method: "POST",
      path: "/api/v1/trips/:tripId/items/:itemId/attachments/presign",
      authClass: "owner",
      handler: handlePresignAttachment,
    },
    {
      method: "GET",
      path: "/api/v1/trips/:tripId/items/:itemId/attachments",
      authClass: "owner",
      handler: handleListAttachments,
    },
    {
      method: "POST",
      path: "/api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId/confirm",
      authClass: "owner",
      handler: handleConfirmAttachment,
    },
    {
      method: "GET",
      path: "/api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId/url",
      authClass: "owner",
      handler: handleOwnerAttachmentUrl,
    },
    {
      method: "DELETE",
      path: "/api/v1/trips/:tripId/items/:itemId/attachments/:attachmentId",
      authClass: "owner",
      handler: handleDeleteAttachment,
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
      handler: makeDeleteTripHandler(deleteConfig),
    },
    // Public / share session routes
    {
      method: "POST",
      path: "/api/v1/share/session",
      authClass: "public",
      handler: handleCreateShareSession({
        rateLimiter,
        allowedOrigins: shareAllowedOrigins,
      }),
    },
    {
      method: "DELETE",
      path: "/api/v1/share/session",
      authClass: "share",
      handler: handleDeleteShareSession,
    },
    {
      method: "GET",
      path: "/api/v1/share/trip",
      authClass: "share",
      handler: handleGetShareTrip,
    },
    {
      method: "GET",
      path: "/api/v1/share/items/:itemId/attachments/:attachmentId/url",
      authClass: "share",
      handler: handleShareAttachmentUrl,
    },
  ];
}

/** Default routes (delete enabled) — used by unit tests and static inspection. */
export const routes: readonly RouteDefinition[] = buildRoutes();

export interface RouterDeps {
  readonly ownerAuth: OwnerAuthService;
  readonly userRepo: UserRepository;
  readonly tripRepo: TripRepository;
  readonly shareRepo?: ShareRepository;
  readonly attachmentRepo?: AttachmentRepository;
  readonly docsStore?: DocsStoreService;
  readonly tripDeleteQueue?: TripDeleteQueueService;
  readonly shareAuth?: ShareAuthService;
  readonly logger?: Logger;
  readonly routes?: readonly RouteDefinition[];
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
 * `CurrentOwner` / `CurrentShare` rather than re-verifying.
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

  const shareRepo =
    deps.shareRepo ??
    // Lazy default: empty in-memory if caller omitted (tests that don't need shares).
    // Importing makeInMemoryShareRepo at top would create a cycle risk — keep inline factory below.
    undefined;

  // Resolve share repo once (prefer deps).
  const resolvedShareRepo = shareRepo;

  // Default in-memory attachment/docs stores for unit tests that omit them.
  // Item delete cascade and share trip attachment meta need these present.
  const attachmentRepoService: AttachmentRepository =
    deps.attachmentRepo ?? makeInMemoryAttachmentRepo();
  const docsStoreService: DocsStoreService =
    deps.docsStore ?? makeMockDocsStore();

  const shareAuth: ShareAuthService =
    deps.shareAuth ??
    (resolvedShareRepo !== undefined
      ? makeShareAuth({
          getCookie: () => request.cookies[SHARE_COOKIE_NAME],
          shareRepo: resolvedShareRepo,
          tripRepo: deps.tripRepo,
        })
      : {
          requireShare: () =>
            Effect.fail(AppError.unauthorized("Share session required")),
        });

  const requestLayer = Layer.succeed(RequestContext, {
    request,
    authClass: route.authClass,
    pathParams,
  });
  const ownerLayer = Layer.succeed(OwnerAuth, deps.ownerAuth);
  const shareLayer = Layer.succeed(ShareAuth, shareAuth);
  const userLayer = Layer.succeed(UserRepo, deps.userRepo);
  const tripLayer = Layer.succeed(TripRepo, deps.tripRepo);

  // ShareRepo layer: only when provided (share routes need it).
  // Use a no-op stub when missing so Layer.mergeAll stays typed.
  const shareRepoService: ShareRepository =
    resolvedShareRepo ??
    ({
      createGrant: () => Effect.fail(AppError.internal()),
      listGrants: () => Effect.fail(AppError.internal()),
      getGrant: () => Effect.fail(AppError.internal()),
      findGrantByTokenHash: () => Effect.fail(AppError.internal()),
      revokeGrant: () => Effect.fail(AppError.internal()),
      createSession: () => Effect.fail(AppError.internal()),
      getSession: () => Effect.fail(AppError.internal()),
      deleteSession: () => Effect.fail(AppError.internal()),
    } satisfies ShareRepository);
  const shareRepoLayer = Layer.succeed(ShareRepo, shareRepoService);
  const attachmentRepoLayer = Layer.succeed(
    AttachmentRepo,
    attachmentRepoService,
  );
  const docsStoreLayer = Layer.succeed(DocsStore, docsStoreService);
  const tripDeleteQueueService: TripDeleteQueueService =
    deps.tripDeleteQueue ?? makeInMemoryTripDeleteQueue();
  const tripDeleteQueueLayer = Layer.succeed(
    TripDeleteQueue,
    tripDeleteQueueService,
  );

  const appLayer = Layer.mergeAll(
    requestLayer,
    ownerLayer,
    shareLayer,
    userLayer,
    tripLayer,
    shareRepoLayer,
    attachmentRepoLayer,
    docsStoreLayer,
    tripDeleteQueueLayer,
  );

  type CoreEnv =
    | OwnerAuth
    | ShareAuth
    | UserRepo
    | TripRepo
    | ShareRepo
    | AttachmentRepo
    | DocsStore
    | TripDeleteQueue
    | RequestContext;

  const program: Effect.Effect<HttpResponse> = Effect.gen(function* () {
    // Auth class gate: verify once, inject principal for the handler.
    if (route.authClass === "owner") {
      const auth = yield* OwnerAuth;
      const principal = yield* auth.requireOwner();
      const ownerHandler = route.handler() as Effect.Effect<
        HttpResponse,
        AppError,
        CoreEnv | CurrentOwner
      >;
      return yield* ownerHandler.pipe(
        Effect.provideService(CurrentOwner, principal),
      );
    }
    if (route.authClass === "share") {
      const auth = yield* ShareAuth;
      const principal = yield* auth.requireShare();
      const shareHandler = route.handler() as Effect.Effect<
        HttpResponse,
        AppError,
        CoreEnv | CurrentShare
      >;
      return yield* shareHandler.pipe(
        Effect.provideService(CurrentShare, principal),
      );
    }
    // Public handlers do not read CurrentOwner / CurrentShare.
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
