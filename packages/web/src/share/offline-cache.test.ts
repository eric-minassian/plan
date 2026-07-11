import { describe, expect, it, vi } from "vitest";
import type { ShareTripDTO } from "@tripplan/domain";
import {
  clearAllShareOfflineStores,
  clearLastShareTrip,
  clearShareTripServiceWorkerCache,
  formatCacheAge,
  LAST_SHARE_TRIP_MAX_AGE_MS,
  LAST_SHARE_TRIP_STORAGE_KEY,
  loadLastShareTrip,
  saveLastShareTrip,
  SHARE_TRIP_SW_CACHE_NAME,
  type ShareTripStorage,
} from "./offline-cache.ts";

const sampleTrip: ShareTripDTO = {
  tripId: "t1",
  title: "Japan",
  timezone: "Asia/Tokyo",
  startDate: "2026-06-01",
  endDate: "2026-06-10",
  ownerDisplayName: "Trip owner",
  items: [],
};

function memoryStorage(
  initial: Record<string, string> = {},
): ShareTripStorage & { readonly store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return store[key] ?? null;
    },
    setItem(key, value) {
      store[key] = value;
    },
    removeItem(key) {
      delete store[key];
    },
  };
}

describe("share offline cache", () => {
  it("round-trips a valid share trip", () => {
    const storage = memoryStorage();
    saveLastShareTrip(sampleTrip, storage, () => new Date("2026-07-01T12:00:00.000Z"));

    const loaded = loadLastShareTrip(
      storage,
      () => new Date("2026-07-01T12:00:00.000Z"),
    );
    expect(loaded).toEqual({
      savedAt: "2026-07-01T12:00:00.000Z",
      trip: sampleTrip,
    });
  });

  it("overwrites previous trip (last-opened only)", () => {
    const storage = memoryStorage();
    saveLastShareTrip(sampleTrip, storage);
    const next: ShareTripDTO = { ...sampleTrip, tripId: "t2", title: "Italy" };
    saveLastShareTrip(next, storage);

    const loaded = loadLastShareTrip(storage);
    expect(loaded?.trip.tripId).toBe("t2");
    expect(loaded?.trip.title).toBe("Italy");
  });

  it("returns undefined and clears corrupt JSON", () => {
    const storage = memoryStorage({
      [LAST_SHARE_TRIP_STORAGE_KEY]: "{not-json",
    });
    expect(loadLastShareTrip(storage)).toBeUndefined();
    expect(storage.store[LAST_SHARE_TRIP_STORAGE_KEY]).toBeUndefined();
  });

  it("returns undefined and clears invalid envelope", () => {
    const storage = memoryStorage({
      [LAST_SHARE_TRIP_STORAGE_KEY]: JSON.stringify({
        savedAt: "x",
        trip: { title: "missing fields" },
      }),
    });
    expect(loadLastShareTrip(storage)).toBeUndefined();
    expect(storage.store[LAST_SHARE_TRIP_STORAGE_KEY]).toBeUndefined();
  });

  it("expires snapshots older than max age", () => {
    const storage = memoryStorage();
    const savedAt = new Date("2026-01-01T00:00:00.000Z");
    saveLastShareTrip(sampleTrip, storage, () => savedAt);
    const later = new Date(savedAt.getTime() + LAST_SHARE_TRIP_MAX_AGE_MS + 1);
    expect(loadLastShareTrip(storage, () => later)).toBeUndefined();
    expect(storage.store[LAST_SHARE_TRIP_STORAGE_KEY]).toBeUndefined();
  });

  it("clearLastShareTrip removes the key", () => {
    const storage = memoryStorage();
    saveLastShareTrip(sampleTrip, storage);
    clearLastShareTrip(storage);
    expect(loadLastShareTrip(storage)).toBeUndefined();
  });

  it("clearShareTripServiceWorkerCache deletes the named cache once", async () => {
    const deleteFn = vi.fn(async () => true);
    const cachesApi = {
      delete: deleteFn,
      keys: vi.fn(async () => [] as string[]),
    } as unknown as CacheStorage;

    await clearShareTripServiceWorkerCache(cachesApi);
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledWith(SHARE_TRIP_SW_CACHE_NAME);
    expect(cachesApi.keys).not.toHaveBeenCalled();
  });

  it("clearShareTripServiceWorkerCache no-ops when caches unavailable", async () => {
    await expect(
      clearShareTripServiceWorkerCache(undefined),
    ).resolves.toBeUndefined();
  });

  it("clearAllShareOfflineStores clears storage and SW cache", async () => {
    const storage = memoryStorage();
    saveLastShareTrip(sampleTrip, storage);
    const deleteFn = vi.fn(async () => true);
    const cachesApi = { delete: deleteFn } as unknown as CacheStorage;

    await clearAllShareOfflineStores(storage, cachesApi);

    expect(storage.store[LAST_SHARE_TRIP_STORAGE_KEY]).toBeUndefined();
    expect(deleteFn).toHaveBeenCalledWith(SHARE_TRIP_SW_CACHE_NAME);
  });
});

describe("formatCacheAge", () => {
  it("formats recent and older ages", () => {
    const now = () => new Date("2026-07-01T12:00:00.000Z");
    expect(formatCacheAge("2026-07-01T11:59:30.000Z", now)).toBe("just now");
    expect(formatCacheAge("2026-07-01T11:50:00.000Z", now)).toBe("10 minutes ago");
    expect(formatCacheAge("2026-07-01T10:00:00.000Z", now)).toBe("2 hours ago");
    expect(formatCacheAge("2026-06-28T12:00:00.000Z", now)).toBe("3 days ago");
  });
});
