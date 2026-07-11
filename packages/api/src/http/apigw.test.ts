import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { buildAbsoluteUrl, fromApiGatewayEvent } from "./apigw.js";

function event(
  overrides: Partial<APIGatewayProxyEventV2> & {
    path?: string;
    method?: string;
  } = {},
): APIGatewayProxyEventV2 {
  const path = overrides.path ?? "/api/v1/me";
  const method = overrides.method ?? "GET";
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: overrides.rawQueryString ?? "",
    headers: {
      host: "abc123.execute-api.us-east-1.amazonaws.com",
      ...(overrides.headers ?? {}),
    },
    requestContext: {
      accountId: "123",
      apiId: "abc123",
      domainName: "abc123.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "abc123",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "1.2.3.4",
        userAgent: "test",
      },
      requestId: "req-url-1",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "10/Jul/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

describe("buildAbsoluteUrl / fromApiGatewayEvent", () => {
  it("uses PUBLIC_API_BASE_URL when configured (ignores X-Forwarded-Host)", () => {
    const ev = event({
      headers: {
        host: "abc123.execute-api.us-east-1.amazonaws.com",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
    const url = buildAbsoluteUrl(
      ev,
      "/api/v1/me",
      "https://plan.ericminassian.com",
    );
    expect(url).toBe("https://plan.ericminassian.com/api/v1/me");
  });

  it("prefers Host over untrusted X-Forwarded-Host when base URL unset", () => {
    const ev = event({
      headers: {
        host: "abc123.execute-api.us-east-1.amazonaws.com",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const url = buildAbsoluteUrl(ev, "/api/v1/health");
    expect(url).toBe(
      "https://abc123.execute-api.us-east-1.amazonaws.com/api/v1/health",
    );
    expect(url).not.toContain("evil.example");
  });

  it("appends query string", () => {
    const ev = event({ rawQueryString: "x=1" });
    const url = buildAbsoluteUrl(
      ev,
      "/api/v1/me",
      "https://plan.ericminassian.com",
    );
    expect(url).toBe("https://plan.ericminassian.com/api/v1/me?x=1");
  });

  it("fromApiGatewayEvent wires public base into request.url", () => {
    const req = fromApiGatewayEvent(event({ path: "/api/v1/me" }), {
      publicApiBaseUrl: "https://plan.ericminassian.com",
    });
    expect(req.url).toBe("https://plan.ericminassian.com/api/v1/me");
    expect(req.path).toBe("/api/v1/me");
    expect(req.method).toBe("GET");
    expect(req.requestId).toBe("req-url-1");
  });
});
