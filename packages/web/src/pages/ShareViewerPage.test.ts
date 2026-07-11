import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SharePublicApi } from "../api/client.ts";
import type { ShareTripDTO } from "@tripplan/domain";
import { ApiClientError } from "../api/errors.ts";
import type { LastShareTripCache } from "../share/offline-cache.ts";
import {
  bootShareViewer,
  clearShareHash,
  invalidateShareViewerBoot,
  isDefinitiveShareAccessError,
  isLikelyOfflineError,
  leaveShareSession,
  resetShareViewerBootForTests,
} from "./ShareViewerPage.tsx";

const sampleTrip: ShareTripDTO = {
  tripId: "t1",
  title: "Japan",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
  ownerDisplayName: "Trip owner",
  items: [],
};

const sampleCache: LastShareTripCache = {
  savedAt: "2026-07-01T12:00:00.000Z",
  trip: sampleTrip,
};

function mockApi(partial: Partial<SharePublicApi> = {}): SharePublicApi {
  return {
    exchangeSession: vi.fn(async () => undefined),
    clearSession: vi.fn(async () => undefined),
    getTrip: vi.fn(async () => sampleTrip),
    ...partial,
  };
}

describe("bootShareViewer", () => {
  beforeEach(() => {
    resetShareViewerBootForTests();
  });

  it("clears the hash even when exchange fails", async () => {
    let hash = "#secret-token-value";
    const clearHash = vi.fn(() => {
      hash = "";
    });
    const api = mockApi({
      exchangeSession: vi.fn(async () => {
        throw new Error("unauthorized");
      }),
      getTrip: vi.fn(async () => {
        throw new Error("no session");
      }),
    });

    const result = await bootShareViewer(api, {
      readToken: () => "secret-token-value",
      clearHash,
      saveTrip: () => {},
      loadCachedTrip: () => undefined,
      isOnline: () => true,
    });

    expect(clearHash).toHaveBeenCalledOnce();
    expect(hash).toBe("");
    expect(result.ok).toBe(false);
  });

  it("clears the hash before awaiting exchange", async () => {
    const order: string[] = [];
    const api = mockApi({
      exchangeSession: vi.fn(async () => {
        order.push("exchange");
      }),
      getTrip: vi.fn(async () => {
        order.push("getTrip");
        return sampleTrip;
      }),
    });

    await bootShareViewer(api, {
      readToken: () => {
        order.push("read");
        return "tok";
      },
      clearHash: () => {
        order.push("clear");
      },
      saveTrip: () => {},
    });

    expect(order).toEqual(["read", "clear", "exchange", "getTrip"]);
  });

  it("falls back to cookie session when exchange fails but getTrip works", async () => {
    const api = mockApi({
      exchangeSession: vi.fn(async () => {
        throw new Error("bad token");
      }),
      getTrip: vi.fn(async () => sampleTrip),
    });
    const saveTrip = vi.fn();

    const result = await bootShareViewer(api, {
      readToken: () => "stale",
      clearHash: () => {},
      saveTrip,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trip.title).toBe("Japan");
      expect(result.fromOfflineCache).toBeUndefined();
    }
    expect(saveTrip).toHaveBeenCalledWith(sampleTrip);
  });

  it("saves the trip after a successful online boot", async () => {
    const api = mockApi();
    const saveTrip = vi.fn();

    const result = await bootShareViewer(api, {
      readToken: () => "tok",
      clearHash: () => {},
      saveTrip,
    });

    expect(result.ok).toBe(true);
    expect(saveTrip).toHaveBeenCalledOnce();
    expect(saveTrip).toHaveBeenCalledWith(sampleTrip);
  });

  it("serves the last-opened cache when getTrip fails offline", async () => {
    const api = mockApi({
      getTrip: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const saveTrip = vi.fn();
    const loadCachedTrip = vi.fn(() => sampleCache);

    const result = await bootShareViewer(api, {
      readToken: () => undefined,
      clearHash: () => {},
      saveTrip,
      loadCachedTrip,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromOfflineCache).toBe(true);
      expect(result.cachedAt).toBe(sampleCache.savedAt);
      expect(result.offlineCacheWithNewToken).toBeUndefined();
      expect(result.trip.title).toBe("Japan");
    }
    expect(saveTrip).not.toHaveBeenCalled();
    expect(loadCachedTrip).toHaveBeenCalledOnce();
  });

  it("flags offline cache when a new hash token could not be opened", async () => {
    const api = mockApi({
      exchangeSession: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      getTrip: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });

    const result = await bootShareViewer(api, {
      readToken: () => "new-token",
      clearHash: () => {},
      saveTrip: () => {},
      loadCachedTrip: () => sampleCache,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromOfflineCache).toBe(true);
      expect(result.offlineCacheWithNewToken).toBe(true);
    }
  });

  it("does not use offline cache for non-network API errors when online", async () => {
    const api = mockApi({
      getTrip: vi.fn(async () => {
        throw new Error("forbidden");
      }),
    });
    const loadCachedTrip = vi.fn(() => sampleCache);
    const clearOfflineStores = vi.fn(async () => undefined);

    const result = await bootShareViewer(api, {
      readToken: () => undefined,
      clearHash: () => {},
      saveTrip: () => {},
      loadCachedTrip,
      clearOfflineStores,
      isOnline: () => true,
    });

    expect(result.ok).toBe(false);
    expect(loadCachedTrip).not.toHaveBeenCalled();
    expect(clearOfflineStores).not.toHaveBeenCalled();
  });

  it("clears offline stores on online 401/403/410 share failures", async () => {
    for (const status of [401, 403, 410] as const) {
      const clearOfflineStores = vi.fn(async () => undefined);
      const api = mockApi({
        getTrip: vi.fn(async () => {
          throw new ApiClientError(status, undefined, "revoked");
        }),
      });

      const result = await bootShareViewer(api, {
        readToken: () => undefined,
        clearHash: () => {},
        saveTrip: () => {},
        loadCachedTrip: () => sampleCache,
        clearOfflineStores,
        isOnline: () => true,
      });

      expect(result.ok).toBe(false);
      expect(clearOfflineStores).toHaveBeenCalledOnce();
    }
  });

  it("does not clear offline stores on network TypeError (still may fall back)", async () => {
    const clearOfflineStores = vi.fn(async () => undefined);
    const api = mockApi({
      getTrip: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });

    const result = await bootShareViewer(api, {
      readToken: () => undefined,
      clearHash: () => {},
      saveTrip: () => {},
      loadCachedTrip: () => sampleCache,
      clearOfflineStores,
      isOnline: () => true,
    });

    expect(result.ok).toBe(true);
    expect(clearOfflineStores).not.toHaveBeenCalled();
  });
});

describe("leaveShareSession", () => {
  beforeEach(() => {
    resetShareViewerBootForTests();
  });

  it("clears offline stores and boot memo when clearSession succeeds", async () => {
    const clearOfflineStores = vi.fn(async () => undefined);
    const api = mockApi();
    invalidateShareViewerBoot();

    await leaveShareSession(api, { clearOfflineStores });

    expect(api.clearSession).toHaveBeenCalledOnce();
    expect(clearOfflineStores).toHaveBeenCalledOnce();
  });

  it("still clears offline stores and boot memo when clearSession fails", async () => {
    const clearOfflineStores = vi.fn(async () => undefined);
    const api = mockApi({
      clearSession: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    await expect(
      leaveShareSession(api, { clearOfflineStores }),
    ).rejects.toThrow("offline");
    expect(clearOfflineStores).toHaveBeenCalledOnce();
  });
});

describe("isLikelyOfflineError", () => {
  it("matches fetch network TypeErrors", () => {
    expect(isLikelyOfflineError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isLikelyOfflineError(new TypeError("NetworkError when attempting"))).toBe(
      true,
    );
  });

  it("does not treat arbitrary TypeErrors as offline", () => {
    expect(isLikelyOfflineError(new TypeError("null is not an object"))).toBe(
      false,
    );
  });
});

describe("isDefinitiveShareAccessError", () => {
  it("recognizes 401/403/404/410", () => {
    expect(isDefinitiveShareAccessError(new ApiClientError(401, undefined))).toBe(
      true,
    );
    expect(isDefinitiveShareAccessError(new ApiClientError(403, undefined))).toBe(
      true,
    );
    expect(isDefinitiveShareAccessError(new ApiClientError(404, undefined))).toBe(
      true,
    );
    expect(isDefinitiveShareAccessError(new ApiClientError(410, undefined))).toBe(
      true,
    );
    expect(isDefinitiveShareAccessError(new ApiClientError(500, undefined))).toBe(
      false,
    );
    expect(isDefinitiveShareAccessError(new Error("x"))).toBe(false);
  });
});

describe("clearShareHash", () => {
  it("no-ops when hash is empty", () => {
    const replaceState = vi.fn();
    clearShareHash(
      { hash: "", pathname: "/s", search: "" } as Location,
      { replaceState } as unknown as History,
    );
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("strips hash via replaceState", () => {
    const replaceState = vi.fn();
    clearShareHash(
      { hash: "#abc", pathname: "/s", search: "" } as Location,
      { replaceState } as unknown as History,
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/s");
  });
});
