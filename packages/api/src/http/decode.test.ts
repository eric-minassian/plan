import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { etagFromVersion, parseIfMatchVersion } from "./decode.js";

describe("parseIfMatchVersion", () => {
  it("parses quoted and bare integers", () => {
    expect(Either.getOrThrow(parseIfMatchVersion('"3"'))).toBe(3);
    expect(Either.getOrThrow(parseIfMatchVersion("3"))).toBe(3);
    expect(Either.getOrThrow(parseIfMatchVersion('W/"2"'))).toBe(2);
  });

  it("rejects missing or non-integer", () => {
    expect(Either.isLeft(parseIfMatchVersion(undefined))).toBe(true);
    expect(Either.isLeft(parseIfMatchVersion(""))).toBe(true);
    expect(Either.isLeft(parseIfMatchVersion("abc"))).toBe(true);
    expect(Either.isLeft(parseIfMatchVersion("0"))).toBe(true);
  });
});

describe("etagFromVersion", () => {
  it("quotes version", () => {
    expect(etagFromVersion(1)).toBe('"1"');
  });
});
