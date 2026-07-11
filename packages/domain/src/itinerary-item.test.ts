import { Schema as S } from "effect";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomDetails,
  CustomFields,
  MAX_CUSTOM_FIELDS,
  NoteDetails,
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
});
