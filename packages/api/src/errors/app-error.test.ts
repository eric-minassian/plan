import { describe, expect, it } from "vitest";
import {
  AppError,
  appErrorToHttpResponse,
  INTERNAL_ERROR_MESSAGE,
  internalFromCause,
} from "./app-error.js";

describe("AppError HTTP mapping", () => {
  const cases: Array<[AppError, number]> = [
    [AppError.validation("bad"), 400],
    [AppError.unauthorized("nope"), 401],
    [AppError.forbidden(), 403],
    [AppError.notFound(), 404],
    [AppError.methodNotAllowed(), 405],
    [AppError.conflict("clash"), 409],
    [new AppError({ type: "PayloadTooLarge", message: "too big" }), 413],
    [new AppError({ type: "RateLimited", message: "slow down" }), 429],
    [new AppError({ type: "AmbiguousEnrichment", message: "ambiguous" }), 422],
    [new AppError({ type: "UpstreamUnavailable", message: "down" }), 502],
    [AppError.internal(), 500],
  ];

  it.each(cases)("error type $0.type maps to $1", (error, status) => {
    const response = appErrorToHttpResponse(error, "req-1");
    expect(response.status).toBe(status);
    const body = JSON.parse(response.body ?? "{}") as {
      type: string;
      requestId: string;
      retryable: boolean;
    };
    expect(body.type).toBe(error.type);
    expect(body.requestId).toBe("req-1");
    expect(typeof body.retryable).toBe("boolean");
  });

  it("includes WWW-Authenticate on Unauthorized when provided", () => {
    const error = AppError.unauthorized("missing", 'Bearer realm="plan"');
    const response = appErrorToHttpResponse(error, "req-2");
    expect(response.headers?.["www-authenticate"]).toBe('Bearer realm="plan"');
  });

  it("internalFromCause never puts cause text in the client message", () => {
    const logs: string[] = [];
    const logger = {
      log: (
        _level: "debug" | "info" | "warn" | "error",
        _message: string,
        fields: Readonly<
          Record<string, string | number | boolean | undefined>
        > = {},
      ) => {
        if (typeof fields.cause === "string") {
          logs.push(fields.cause);
        }
      },
      request: () => {},
    };
    const error = internalFromCause(
      new Error("secret jwks failure"),
      { component: "test" },
      logger,
    );
    expect(error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(error.message).not.toContain("secret");
    expect(logs).toContain("secret jwks failure");
  });
});
