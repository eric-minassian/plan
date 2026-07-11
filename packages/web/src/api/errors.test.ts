import { describe, expect, it } from "vitest";
import {
  ApiClientError,
  formatApiError,
  isUnauthorizedError,
  parseApiErrorBody,
} from "./errors.ts";

describe("parseApiErrorBody", () => {
  it("parses a valid envelope", () => {
    const body = parseApiErrorBody({
      type: "ValidationError",
      message: "bad title",
      retryable: false,
      requestId: "req-1",
      details: { issues: "title too short" },
    });
    expect(body).toEqual({
      type: "ValidationError",
      message: "bad title",
      retryable: false,
      requestId: "req-1",
      details: { issues: "title too short" },
    });
  });

  it("rejects unknown error types", () => {
    expect(
      parseApiErrorBody({
        type: "TotallyNewError",
        message: "x",
        retryable: false,
        requestId: "r",
      }),
    ).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    expect(
      parseApiErrorBody({
        type: "NotFound",
        message: "gone",
        retryable: false,
      }),
    ).toBeUndefined();
    expect(parseApiErrorBody(null)).toBeUndefined();
    expect(parseApiErrorBody("nope")).toBeUndefined();
  });

  it("accepts every domain ErrorCode value", () => {
    const types = [
      "NotFound",
      "Forbidden",
      "Unauthorized",
      "ValidationError",
      "MethodNotAllowed",
      "Conflict",
      "PayloadTooLarge",
      "RateLimited",
      "UpstreamUnavailable",
      "AmbiguousEnrichment",
      "InternalError",
    ] as const;
    for (const type of types) {
      expect(
        parseApiErrorBody({
          type,
          message: "m",
          retryable: false,
          requestId: "id",
        })?.type,
      ).toBe(type);
    }
  });
});

describe("formatApiError", () => {
  it("includes requestId suffix", () => {
    const err = new ApiClientError(400, {
      type: "ValidationError",
      message: "Invalid",
      retryable: false,
      requestId: "abc",
    });
    expect(formatApiError(err)).toBe("Invalid (request abc)");
  });

  it("appends details.issues when present", () => {
    const err = new ApiClientError(400, {
      type: "ValidationError",
      message: "Request validation failed",
      retryable: false,
      requestId: "x",
      details: { issues: "Invalid IANA time zone" },
    });
    expect(formatApiError(err)).toContain("Invalid IANA time zone");
    expect(formatApiError(err)).toContain("request x");
  });

  it("surfaces AmbiguousEnrichment candidates", () => {
    const err = new ApiClientError(422, {
      type: "AmbiguousEnrichment",
      message: "Multiple matching flights",
      retryable: false,
      requestId: "amb",
      details: {
        candidates: [
          {
            airlineCode: "UA",
            flightNumber: "1",
            departureAirport: "SFO",
            arrivalAirport: "EWR",
          },
          {
            airlineCode: "UA",
            flightNumber: "1",
            departureAirport: "LAX",
            arrivalAirport: "EWR",
          },
        ],
      },
    });
    const text = formatApiError(err);
    expect(text).toContain("SFO→EWR");
    expect(text).toContain("LAX→EWR");
  });

  it("falls back for plain Error", () => {
    expect(formatApiError(new Error("boom"))).toBe("boom");
  });

  it("falls back for unknown", () => {
    expect(formatApiError(42)).toBe("Something went wrong");
  });
});

describe("isUnauthorizedError", () => {
  it("detects status 401 and Unauthorized type", () => {
    expect(isUnauthorizedError(new ApiClientError(401, undefined))).toBe(true);
    expect(
      isUnauthorizedError(
        new ApiClientError(403, {
          type: "Unauthorized",
          message: "no",
          retryable: false,
          requestId: "r",
        }),
      ),
    ).toBe(true);
    expect(
      isUnauthorizedError(
        new ApiClientError(404, {
          type: "NotFound",
          message: "no",
          retryable: false,
          requestId: "r",
        }),
      ),
    ).toBe(false);
  });
});
