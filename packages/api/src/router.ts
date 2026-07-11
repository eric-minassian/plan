import { Effect, Layer } from "effect";
import { CurrentOwner } from "./auth/current-owner.js";
import { OwnerAuth, type OwnerAuthService } from "./auth/owner-auth.js";
import {
  makeShareAuthStub,
  ShareAuth,
  SHARE_COOKIE_NAME,
  type ShareAuthService,
} from "./auth/share-auth.js";
import {
  AppError,
  appErrorToHttpResponse,
  unexpectedToAppError,
} from "./errors/app-error.js";
import { RequestContext } from "./http/request-context.js";
import type {
  AuthClass,
  HttpRequest,
  HttpResponse,
} from "./http/types.js";
import type { Logger } from "./logging/logger.js";
import { consoleLogger } from "./logging/logger.js";
import { UserRepo, type UserRepository } from "./repos/user-repo.js";
import { handleHealth } from "./routes/health.js";
import { handleMe } from "./routes/me.js";

export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  readonly authClass: AuthClass;
  readonly handler: () => Effect.Effect<
    HttpResponse,
    AppError,
    | OwnerAuth
    | ShareAuth
    | UserRepo
    | RequestContext
    | CurrentOwner
  >;
}

/**
 * Implemented routes. Share placeholders reserved for later PRs
 * (session exchange / share trip) without applying blanket JWT.
 */
export const routes: readonly RouteDefinition[] = [
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
];

export interface RouterDeps {
  readonly ownerAuth: OwnerAuthService;
  readonly userRepo: UserRepository;
  readonly shareAuth?: ShareAuthService;
  readonly logger?: Logger;
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

  const exact = routes.find(
    (r) => r.method === request.method && r.path === request.path,
  );

  if (exact === undefined) {
    const pathMatches = routes.filter((r) => r.path === request.path);
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

  const route = exact;

  const shareAuth: ShareAuthService =
    deps.shareAuth ??
    makeShareAuthStub(() => request.cookies[SHARE_COOKIE_NAME]);

  const requestLayer = Layer.succeed(RequestContext, {
    request,
    authClass: route.authClass,
  });
  const ownerLayer = Layer.succeed(OwnerAuth, deps.ownerAuth);
  const shareLayer = Layer.succeed(ShareAuth, shareAuth);
  const userLayer = Layer.succeed(UserRepo, deps.userRepo);
  const appLayer = Layer.mergeAll(
    requestLayer,
    ownerLayer,
    shareLayer,
    userLayer,
  );

  // Handlers that do not yield CurrentOwner still list it on RouteDefinition;
  // narrow R after the owner gate injects the principal.
  type HandlerEnv =
    | OwnerAuth
    | ShareAuth
    | UserRepo
    | RequestContext
    | CurrentOwner;
  type CoreEnv = OwnerAuth | ShareAuth | UserRepo | RequestContext;

  const program = Effect.gen(function* () {
    // Auth class gate: verify once, inject principal for the handler.
    if (route.authClass === "owner") {
      const auth = yield* OwnerAuth;
      const principal = yield* auth.requireOwner();
      const ownerHandler: Effect.Effect<HttpResponse, AppError, HandlerEnv> =
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
