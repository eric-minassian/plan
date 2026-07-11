import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SharePublicApi } from "../api/client.ts";
import type { ShareTripDTO } from "@tripplan/domain";
import {
  bootShareViewer,
  clearShareHash,
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
  attachments: [],
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

    const result = await bootShareViewer(api, {
      readToken: () => "stale",
      clearHash: () => {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trip.title).toBe("Japan");
    }
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
