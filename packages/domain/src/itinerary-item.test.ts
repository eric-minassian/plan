import { Either, Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomDetails,
  CustomFields,
  decodeUpdateDetails,
  MAX_CUSTOM_FIELDS,
  NoteDetails,
  UpdateItineraryItem,
} from "./itinerary-item.js";

describe("CustomDetails field caps", () => {
  it(`accepts up to ${MAX_CUSTOM_FIELDS} fields with key≤64 and value≤200`, () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_FIELDS; i += 1) {
      fields[`k${i}`] = "v".repeat(200);
    }
    const decoded = S.decodeUnknownEither(CustomDetails)({ fields });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("rejects more than 20 custom fields", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_FIELDS + 1; i += 1) {
      fields[`k${i}`] = "v";
    }
    const decoded = S.decodeUnknownEither(CustomFields)(fields);
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("rejects keys longer than 64 characters", () => {
    const decoded = S.decodeUnknownEither(CustomFields)({
      ["k".repeat(65)]: "ok",
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("rejects values longer than 200 characters", () => {
    const decoded = S.decodeUnknownEither(CustomFields)({
      key: "v".repeat(201),
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("allows empty fields object and omitted fields", () => {
    expect(Either.isRight(S.decodeUnknownEither(CustomDetails)({}))).toBe(true);
    expect(
      Either.isRight(S.decodeUnknownEither(CustomDetails)({ fields: {} })),
    ).toBe(true);
  });
});

describe("NoteDetails", () => {
  it("decodes empty object (note body lives in base notes)", () => {
    const decoded = S.decodeUnknownEither(NoteDetails)({});
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right).toEqual({});
    }
  });

  it("rejects non-empty details payloads", () => {
    const decoded = S.decodeUnknownEither(NoteDetails)({ body: "secret" });
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("UpdateItineraryItem", () => {
  it("accepts partial patches without type", () => {
    const decoded = S.decodeUnknownEither(UpdateItineraryItem)({
      title: "New title",
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("rejects payloads that include type (immutable)", () => {
    const decoded = S.decodeUnknownEither(UpdateItineraryItem)({
      type: "hotel",
      title: "x",
    });
    expect(Either.isLeft(decoded)).toBe(true);
    if (Either.isLeft(decoded)) {
      expect(String(decoded.left.message)).toContain("type is immutable");
    }
  });
});

describe("decodeUpdateDetails", () => {
  it("decodes flight details for type flight", () => {
    const result = decodeUpdateDetails("flight", {
      flightNumber: "AA100",
      airlineCode: "AA",
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects flight details missing flightNumber", () => {
    const result = decodeUpdateDetails("flight", { airlineCode: "AA" });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("requires empty details for note", () => {
    expect(Either.isRight(decodeUpdateDetails("note", {}))).toBe(true);
    expect(Either.isLeft(decodeUpdateDetails("note", { body: "x" }))).toBe(true);
  });
});
