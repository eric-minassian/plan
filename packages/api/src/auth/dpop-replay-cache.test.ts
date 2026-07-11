import { describe, expect, it } from "vitest";
import { makeDpopReplayCache } from "./dpop-replay-cache.js";

describe("makeDpopReplayCache", () => {
  it("returns false on first sighting and true on replay", () => {
    const isReplay = makeDpopReplayCache(60);
    const proof = { jti: "j1", jkt: "k1", iat: 1 };
    expect(isReplay(proof)).toBe(false);
    expect(isReplay(proof)).toBe(true);
  });

  it("treats different jti as distinct", () => {
    const isReplay = makeDpopReplayCache(60);
    expect(isReplay({ jti: "a", jkt: "k", iat: 1 })).toBe(false);
    expect(isReplay({ jti: "b", jkt: "k", iat: 1 })).toBe(false);
  });
});
