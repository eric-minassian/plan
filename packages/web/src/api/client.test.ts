import type { AuthClient } from "@ericminassian/auth/client";
import { AuthError } from "@ericminassian/auth/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, createTripPlanApi } from "./client.ts";
import { ApiClientError } from "./errors.ts";

beforeAll(() => {
  vi.stubGlobal("window", {
    location: { origin: "https://plan.ericminassian.com" },
  });
});

function mockAuth(
  fetchWithAuth: AuthClient["fetchWithAuth"],
): AuthClient {
  return {
    fetchWithAuth,
  } as unknown as AuthClient;
}

const sampleTrip = {
  tripId: "t1",
  ownerId: "u1",
  title: "Lisbon",
  timezone: "Europe/Lisbon",
  startDate: "2026-06-01",
  endDate: "2026-06-07",
  version: 1,
  status: "active" as const,
};

describe("apiUrl", () => {
  it("builds absolute SPA-origin URLs", () => {
    expect(apiUrl("/api/v1/trips", "https://plan.ericminassian.com")).toBe(
      "https://plan.ericminassian.com/api/v1/trips",
    );
  });
});

describe("createTripPlanApi", () => {
  it("decodes list trips success body", async () => {
    const fetchWithAuth = vi.fn(async () =>
      new Response(JSON.stringify({ trips: [sampleTrip] }), { status: 200 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    const page = await api.listTrips();
    expect(page.trips).toHaveLength(1);
    expect(page.trips[0]?.title).toBe("Lisbon");
    expect(fetchWithAuth).toHaveBeenCalledOnce();
  });

  it("rejects list body missing trips array", async () => {
    const fetchWithAuth = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    await expect(api.listTrips()).rejects.toBeInstanceOf(ApiClientError);
    await expect(api.listTrips()).rejects.toThrow(/Invalid trip list/);
  });

  it("throws ApiClientError on invalid JSON", async () => {
    const fetchWithAuth = vi.fn(
      async () => new Response("<html>nope</html>", { status: 200 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    await expect(api.listTrips()).rejects.toThrow(/Invalid JSON/);
  });

  it("parses error envelope on non-OK", async () => {
    const fetchWithAuth = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "ValidationError",
            message: "bad",
            retryable: false,
            requestId: "r1",
          }),
          { status: 400 },
        ),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    await expect(api.listTrips()).rejects.toSatisfy((e: unknown) => {
      return e instanceof ApiClientError && e.body?.requestId === "r1";
    });
  });

  it("invokes onUnauthorized on 401", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const fetchWithAuth = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "Unauthorized",
            message: "nope",
            retryable: false,
            requestId: "r",
          }),
          { status: 401 },
        ),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth), { onUnauthorized });
    await expect(api.listTrips()).rejects.toBeInstanceOf(ApiClientError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("invokes onUnauthorized on login_required from SDK", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const fetchWithAuth = vi.fn(async () => {
      throw new AuthError("login_required", "no refresh token");
    });
    const api = createTripPlanApi(mockAuth(fetchWithAuth), { onUnauthorized });
    await expect(api.listTrips()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("decodes create trip response", async () => {
    const fetchWithAuth = vi.fn(
      async () => new Response(JSON.stringify(sampleTrip), { status: 201 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    const trip = await api.createTrip({
      title: "Lisbon",
      timezone: "Europe/Lisbon",
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
    expect(trip.tripId).toBe("t1");
  });

  it("rejects create response missing tripId", async () => {
    const fetchWithAuth = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: "x" }), { status: 201 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    await expect(
      api.createTrip({
        title: "Lisbon",
        timezone: "Europe/Lisbon",
        startDate: "2026-06-01",
        endDate: "2026-06-07",
      }),
    ).rejects.toThrow(/Invalid trip response/);
  });
});
