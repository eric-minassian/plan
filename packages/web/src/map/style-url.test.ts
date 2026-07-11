import { describe, expect, it } from "vitest";
import { hasMapTilerKey, mapTilerStyleUrl } from "./style-url.ts";

describe("hasMapTilerKey", () => {
  it("rejects empty / whitespace", () => {
    expect(hasMapTilerKey("")).toBe(false);
    expect(hasMapTilerKey("   ")).toBe(false);
  });

  it("accepts non-empty keys", () => {
    expect(hasMapTilerKey("abc123")).toBe(true);
  });
});

describe("mapTilerStyleUrl", () => {
  it("encodes the key in the MapTiler style URL", () => {
    const url = mapTilerStyleUrl("a+b/c");
    expect(url).toContain("api.maptiler.com");
    expect(url).toContain("streets-v2-dark");
    expect(url).toContain(`key=${encodeURIComponent("a+b/c")}`);
  });
});
