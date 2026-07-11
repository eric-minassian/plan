import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeCreateItem,
  decodeCreateTrip,
  decodeItemResponse,
  decodeTripDetailResponse,
  decodeTripListResponse,
  decodeTripResponse,
  decodeUpdateItem,
  etagFromVersion,
} from "./decode.ts";
import { ApiClientError } from "./errors.ts";

const sampleTrip = {
  tripId: "t1",
  ownerId: "u1",
  title: "Lisbon",
  timezone: "Europe/Lisbon",
  startDate: "2026-06-01",
  endDate: "2026-06-07",
  version: 1,
  status: "active",
};

const sampleNote = {
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

describe("decodeCreateTrip", () => {
  it("accepts valid create payload", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "Europe/Lisbon",
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects invalid IANA timezone", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "Not/A_Zone",
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects invalid civil date", () => {
    const result = decodeCreateTrip({
      title: "Lisbon",
      timezone: "UTC",
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("decodeTripListResponse", () => {
  it("requires trips array", () => {
    expect(() => decodeTripListResponse({}, 200)).toThrow(ApiClientError);
    const ok = decodeTripListResponse({ trips: [sampleTrip] }, 200);
    expect(ok.trips).toHaveLength(1);
  });
});

describe("decodeTripResponse", () => {
  it("requires core trip fields", () => {
    expect(() => decodeTripResponse({ title: "x" }, 201)).toThrow(
      ApiClientError,
    );
    expect(decodeTripResponse(sampleTrip, 201).tripId).toBe("t1");
  });
});

describe("decodeTripDetailResponse", () => {
  it("requires items array", () => {
    expect(() => decodeTripDetailResponse(sampleTrip, 200)).toThrow(
      ApiClientError,
    );
    const ok = decodeTripDetailResponse(
      { ...sampleTrip, items: [sampleNote] },
      200,
    );
    expect(ok.items).toHaveLength(1);
  });
});

describe("decodeItemResponse", () => {
  it("decodes flight and note", () => {
    expect(decodeItemResponse(sampleNote, 201).type).toBe("note");
    const flight = decodeItemResponse(
      {
        itemId: "i2",
        tripId: "t1",
        type: "flight",
        title: "UA 100",
        details: { flightNumber: "100" },
        sortKey: 1000,
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      201,
    );
    expect(flight.type).toBe("flight");
  });
});

describe("decodeCreateItem", () => {
  it("accepts note and flight create payloads", () => {
    expect(
      Either.isRight(
        decodeCreateItem({
          type: "note",
          title: "Hello",
          notes: "body",
          details: {},
        }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decodeCreateItem({
          type: "flight",
          title: "UA 100",
          startAt: "2026-06-01T10:00:00-07:00",
          details: { flightNumber: "100", airlineCode: "UA" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects note with non-empty details", () => {
    expect(
      Either.isLeft(
        decodeCreateItem({
          type: "note",
          title: "Hello",
          details: { extra: true },
        }),
      ),
    ).toBe(true);
  });
});

describe("decodeUpdateItem", () => {
  it("rejects immutable type field", () => {
    expect(
      Either.isLeft(decodeUpdateItem({ type: "flight", title: "x" })),
    ).toBe(true);
  });

  it("accepts partial title patch", () => {
    expect(Either.isRight(decodeUpdateItem({ title: "New title" }))).toBe(
      true,
    );
  });

  it("accepts null startAt/endAt clear sentinels", () => {
    const decoded = decodeUpdateItem({ startAt: null, endAt: null });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.startAt).toBeNull();
      expect(decoded.right.endAt).toBeNull();
    }
  });
});

describe("etagFromVersion", () => {
  it("quotes integer version", () => {
    expect(etagFromVersion(3)).toBe('"3"');
  });
});
