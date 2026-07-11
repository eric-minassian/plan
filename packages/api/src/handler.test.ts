import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { makeMockOwnerAuth, mockPrincipal } from "./auth/mock-owner-auth.js";
import { createHandler } from "./handler.js";
import { silentLogger } from "./logging/logger.js";
import { makeInMemoryTripRepo } from "./repos/trip-repo.js";
import { makeInMemoryUserRepo } from "./repos/user-repo.js";

function event(
  partial: Partial<APIGatewayProxyEventV2> & {
    method: string;
    path: string;
  },
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${partial.method} ${partial.path}`,
    rawPath: partial.path,
    rawQueryString: "",
    headers: {
      host: "plan.ericminassian.com",
      "x-forwarded-proto": "https",
      ...(partial.headers ?? {}),
    },
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "plan.ericminassian.com",
      domainPrefix: "plan",
      http: {
        method: partial.method,
        path: partial.path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "apigw-req-1",
      routeKey: `${partial.method} ${partial.path}`,
      stage: "$default",
      time: "10/Jul/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...partial,
  } as APIGatewayProxyEventV2;
}

const lambdaContext = {
  awsRequestId: "lambda-1",
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123:function:test",
  logGroupName: "/aws/lambda/test",
  logStreamName: "stream",
  memoryLimitInMB: "128",
  getRemainingTimeInMillis: () => 1000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
} as Context;

describe("Lambda handler", () => {
  it("serves public health", async () => {
    const handler = createHandler({
      ownerAuth: makeMockOwnerAuth(null),
      userRepo: makeInMemoryUserRepo(),
      tripRepo: makeInMemoryTripRepo(),
      logger: silentLogger,
    });
    const result = await handler(
      event({ method: "GET", path: "/api/v1/health" }),
      lambdaContext,
      () => {},
    );
    expect(result).toBeDefined();
    if (result === undefined || typeof result === "string") {
      throw new Error("expected structured result");
    }
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ status: "ok" });
  });

  it("serves /me with mock owner", async () => {
    const handler = createHandler({
      ownerAuth: makeMockOwnerAuth(
        mockPrincipal({ sub: "owner-1", nickname: "Sam" }),
      ),
      userRepo: makeInMemoryUserRepo(),
      tripRepo: makeInMemoryTripRepo(),
      logger: silentLogger,
    });
    const result = await handler(
      event({ method: "GET", path: "/api/v1/me" }),
      lambdaContext,
      () => {},
    );
    expect(result).toBeDefined();
    if (result === undefined || typeof result === "string") {
      throw new Error("expected structured result");
    }
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? "{}") as {
      userId: string;
      displayName: string;
    };
    expect(body.userId).toBe("owner-1");
    expect(body.displayName).toBe("Sam");
  });
});
