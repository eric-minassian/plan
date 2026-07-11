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

  it("decodes get trip detail with items", async () => {
    const note = {
      itemId: "i1",
      tripId: "t1",
      type: "note" as const,
      title: "Pack",
      notes: "socks",
      details: {},
      sortKey: 1000,
      version: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchWithAuth = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...sampleTrip, items: [note] }), {
          status: 200,
        }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    const detail = await api.getTrip("t1");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.type).toBe("note");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "https://plan.ericminassian.com/api/v1/trips/t1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates an item with JSON body and optional Idempotency-Key", async () => {
    const flight = {
      itemId: "i2",
      tripId: "t1",
      type: "flight" as const,
      title: "UA 100",
      details: { flightNumber: "100", airlineCode: "UA" },
      sortKey: 1000,
      version: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchWithAuth = vi.fn(
      async () => new Response(JSON.stringify(flight), { status: 201 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    const created = await api.createItem(
      "t1",
      {
        type: "flight",
        title: "UA 100",
        details: { flightNumber: "100", airlineCode: "UA" },
      },
      { idempotencyKey: "session-1" },
    );
    expect(created.itemId).toBe("i2");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "https://plan.ericminassian.com/api/v1/trips/t1/items",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Idempotency-Key": "session-1",
        }),
      }),
    );
  });

  it("patches item with If-Match", async () => {
    const note = {
      itemId: "i1",
      tripId: "t1",
      type: "note" as const,
      title: "Updated",
      notes: "x",
      details: {},
      sortKey: 1000,
      version: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const fetchWithAuth = vi.fn(
      async () => new Response(JSON.stringify(note), { status: 200 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    const updated = await api.updateItem("t1", "i1", 1, { title: "Updated" });
    expect(updated.version).toBe(2);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "https://plan.ericminassian.com/api/v1/trips/t1/items/i1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "If-Match": '"1"',
        }),
      }),
    );
  });

  it("deletes item with empty 204 body", async () => {
    const fetchWithAuth = vi.fn(
      async () => new Response(null, { status: 204 }),
    );
    const api = createTripPlanApi(mockAuth(fetchWithAuth));
    await expect(api.deleteItem("t1", "i1")).resolves.toBeUndefined();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "https://plan.ericminassian.com/api/v1/trips/t1/items/i1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
