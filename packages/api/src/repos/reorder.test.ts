import { describe, expect, it } from "vitest";
import {
  REORDER_CHUNK_SIZE,
  SORT_KEY_STEP,
  chunkArray,
  computeReorderSortKeys,
  isFullPermutation,
  nextAppendSortKey,
} from "./reorder.js";

describe("computeReorderSortKeys", () => {
  it("assigns (index+1)*1000", () => {
    const keys = computeReorderSortKeys(["a", "b", "c"]);
    expect(keys).toEqual([
      { itemId: "a", sortKey: 1000 },
      { itemId: "b", sortKey: 2000 },
      { itemId: "c", sortKey: 3000 },
    ]);
    expect(SORT_KEY_STEP).toBe(1000);
  });

  it("handles empty and single", () => {
    expect(computeReorderSortKeys([])).toEqual([]);
    expect(computeReorderSortKeys(["only"])).toEqual([
      { itemId: "only", sortKey: 1000 },
    ]);
  });

  it("assigns dense keys for 100 items", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `i${i}`);
    const keys = computeReorderSortKeys(ids);
    expect(keys).toHaveLength(100);
    expect(keys[0]?.sortKey).toBe(1000);
    expect(keys[99]?.sortKey).toBe(100_000);
    expect(keys[24]?.sortKey).toBe(25_000);
  });
});

describe("isFullPermutation", () => {
  it("accepts exact reorder", () => {
    const current = new Set(["a", "b", "c"]);
    expect(isFullPermutation(["c", "a", "b"], current)).toBe(true);
  });

  it("rejects missing, extra, duplicate, or wrong length", () => {
    const current = new Set(["a", "b", "c"]);
    expect(isFullPermutation(["a", "b"], current)).toBe(false);
    expect(isFullPermutation(["a", "b", "c", "d"], current)).toBe(false);
    expect(isFullPermutation(["a", "b", "d"], current)).toBe(false);
    expect(isFullPermutation(["a", "a", "b"], current)).toBe(false);
  });
});

describe("chunkArray", () => {
  it("chunks at REORDER_CHUNK_SIZE boundary", () => {
    const ids = Array.from({ length: 100 }, (_, i) => i);
    const chunks = chunkArray(ids, REORDER_CHUNK_SIZE);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.length <= REORDER_CHUNK_SIZE)).toBe(true);
    expect(chunks[0]).toHaveLength(25);
    expect(chunks[3]).toHaveLength(25);
    expect(chunks.flat()).toEqual(ids);
  });

  it("handles remainder chunks", () => {
    const chunks = chunkArray([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("nextAppendSortKey", () => {
  it("starts at 1000 and appends after max", () => {
    expect(nextAppendSortKey([])).toBe(1000);
    expect(nextAppendSortKey([1000, 2000])).toBe(3000);
    expect(nextAppendSortKey([5000, 1000])).toBe(6000);
  });
});
