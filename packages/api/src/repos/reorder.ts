/**
 * Pure sortKey reorder helpers (design: never encode sortKey in SK).
 *
 * Algorithm:
 * 1. Full permutation of all item IDs
 * 2. sortKey = (index + 1) * SORT_KEY_STEP
 * 3. Apply updates in chunks of ≤ REORDER_CHUNK_SIZE
 */

/** Gap between consecutive sort keys after a full reorder. */
export const SORT_KEY_STEP = 1000;

/** Max Dynamo UpdateItem operations per sequential batch. */
export const REORDER_CHUNK_SIZE = 25;

/** Hard limit: itinerary items per trip. */
export const MAX_ITEMS_PER_TRIP = 100;

/** Optional Idempotency-Key header max length. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export interface ItemSortAssignment {
  readonly itemId: string;
  readonly sortKey: number;
}

/**
 * Assign sortKey = (index + 1) * SORT_KEY_STEP for a full ordered list of item IDs.
 */
export function computeReorderSortKeys(
  orderedItemIds: readonly string[],
): readonly ItemSortAssignment[] {
  return orderedItemIds.map((itemId, index) => ({
    itemId,
    sortKey: (index + 1) * SORT_KEY_STEP,
  }));
}

/**
 * True when `requested` is a permutation of `currentIds`
 * (same multiset: same length, no duplicates, no unknowns).
 */
export function isFullPermutation(
  requested: readonly string[],
  currentIds: ReadonlySet<string>,
): boolean {
  if (requested.length !== currentIds.size) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of requested) {
    if (!currentIds.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

/** Split an array into sequential chunks of at most `size` (size ≥ 1). */
export function chunkArray<T>(
  items: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (size < 1) {
    throw new Error("chunk size must be ≥ 1");
  }
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Next append sortKey: max(existing) + SORT_KEY_STEP, or SORT_KEY_STEP when empty.
 * Does not require dense keys — works after partial deletes.
 */
export function nextAppendSortKey(existingSortKeys: readonly number[]): number {
  let max = 0;
  for (const k of existingSortKeys) {
    if (k > max) {
      max = k;
    }
  }
  return max + SORT_KEY_STEP;
}
