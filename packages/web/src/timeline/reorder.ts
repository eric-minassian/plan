/**
 * Pure reorder helpers for the trip timeline.
 *
 * Display order within a day is Instant then sortKey (domain day-bucket).
 * sortKey only changes relative order among items that share the same startAt
 * (or among unscheduled items with no startAt). Cross-day placement is owned
 * by times, not reorder.
 */

export type OrderableItem = {
  readonly itemId: string;
  readonly startAt?: string | undefined;
};

export type VisualBuckets<T extends OrderableItem> = {
  readonly days: ReadonlyArray<{ readonly items: readonly T[] }>;
  readonly unscheduled: readonly T[];
};

/** Day buckets (chronological) then unscheduled — full trip permutation source. */
export function visualOrderIds<T extends OrderableItem>(
  buckets: VisualBuckets<T>,
): string[] {
  const ids: string[] = [];
  for (const day of buckets.days) {
    for (const item of day.items) {
      ids.push(item.itemId);
    }
  }
  for (const item of buckets.unscheduled) {
    ids.push(item.itemId);
  }
  return ids;
}

/** Start times that compare equal for sortKey-primary grouping (including both missing). */
export function sameStartAtGroup(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return a === b;
}

/**
 * Move `itemId` relative to `targetId` in a full id permutation.
 * - Source index &lt; target index → insert **after** target (drag down).
 * - Source index &gt; target index → insert **before** target (drag up).
 * Returns `undefined` when ids are missing or the move is a no-op identity.
 */
export function moveItemRelativeTo(
  orderedIds: readonly string[],
  itemId: string,
  targetId: string,
): string[] | undefined {
  if (itemId === targetId) {
    return undefined;
  }
  const from = orderedIds.indexOf(itemId);
  const to = orderedIds.indexOf(targetId);
  if (from === -1 || to === -1) {
    return undefined;
  }

  const without = orderedIds.filter((id) => id !== itemId);
  // After removal, target index shifts left if source was before it.
  const targetIndex = without.indexOf(targetId);
  if (targetIndex === -1) {
    return undefined;
  }

  // Drag down (source was before target): land after target.
  // Drag up (source was after target): land before target.
  const insertAt = from < to ? targetIndex + 1 : targetIndex;
  const next = [...without];
  next.splice(insertAt, 0, itemId);

  if (next.length === orderedIds.length && next.every((id, i) => id === orderedIds[i])) {
    return undefined;
  }
  return next;
}

/**
 * Swap `itemId` with its neighbor in `direction` within `orderedIds`.
 * Returns `undefined` if out of bounds or missing.
 */
export function swapAdjacent(
  orderedIds: readonly string[],
  itemId: string,
  direction: "up" | "down",
): string[] | undefined {
  const index = orderedIds.indexOf(itemId);
  if (index === -1) {
    return undefined;
  }
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= orderedIds.length) {
    return undefined;
  }
  const next = [...orderedIds];
  const a = next[index];
  const b = next[swapWith];
  if (a === undefined || b === undefined) {
    return undefined;
  }
  next[index] = b;
  next[swapWith] = a;
  return next;
}

/**
 * Whether ↑/↓ against the neighbor in a **section list** would change visible
 * order (same startAt group). Cross-section moves are not allowed.
 */
export function canMoveInSection(
  sectionItems: readonly OrderableItem[],
  itemId: string,
  direction: "up" | "down",
): boolean {
  const index = sectionItems.findIndex((i) => i.itemId === itemId);
  if (index === -1) {
    return false;
  }
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= sectionItems.length) {
    return false;
  }
  const item = sectionItems[index];
  const neighbor = sectionItems[neighborIndex];
  if (item === undefined || neighbor === undefined) {
    return false;
  }
  return sameStartAtGroup(item.startAt, neighbor.startAt);
}

/**
 * Apply an adjacent swap within one section, then rebuild the full visual
 * permutation (days then unscheduled). Returns `undefined` if the move is
 * invalid (bounds, different startAt group, or missing id).
 */
export function reorderWithinSection<T extends OrderableItem>(
  buckets: VisualBuckets<T>,
  sectionKey: "unscheduled" | number,
  itemId: string,
  direction: "up" | "down",
): string[] | undefined {
  const section =
    sectionKey === "unscheduled"
      ? buckets.unscheduled
      : buckets.days[sectionKey]?.items;
  if (section === undefined) {
    return undefined;
  }
  if (!canMoveInSection(section, itemId, direction)) {
    return undefined;
  }

  const sectionIds = section.map((i) => i.itemId);
  const swapped = swapAdjacent(sectionIds, itemId, direction);
  if (swapped === undefined) {
    return undefined;
  }

  return rebuildFullOrder(buckets, sectionKey, swapped);
}

/**
 * Drag-drop within one section among same startAt group only.
 * Rebuilds full trip permutation.
 */
export function dropWithinSection<T extends OrderableItem>(
  buckets: VisualBuckets<T>,
  sectionKey: "unscheduled" | number,
  itemId: string,
  targetId: string,
): string[] | undefined {
  if (itemId === targetId) {
    return undefined;
  }
  const section =
    sectionKey === "unscheduled"
      ? buckets.unscheduled
      : buckets.days[sectionKey]?.items;
  if (section === undefined) {
    return undefined;
  }

  const source = section.find((i) => i.itemId === itemId);
  const target = section.find((i) => i.itemId === targetId);
  if (source === undefined || target === undefined) {
    return undefined;
  }
  if (!sameStartAtGroup(source.startAt, target.startAt)) {
    return undefined;
  }

  const sectionIds = section.map((i) => i.itemId);
  const moved = moveItemRelativeTo(sectionIds, itemId, targetId);
  if (moved === undefined) {
    return undefined;
  }

  return rebuildFullOrder(buckets, sectionKey, moved);
}

function rebuildFullOrder<T extends OrderableItem>(
  buckets: VisualBuckets<T>,
  sectionKey: "unscheduled" | number,
  sectionIds: readonly string[],
): string[] {
  const ids: string[] = [];
  for (let d = 0; d < buckets.days.length; d += 1) {
    if (sectionKey === d) {
      ids.push(...sectionIds);
    } else {
      const day = buckets.days[d];
      if (day !== undefined) {
        for (const item of day.items) {
          ids.push(item.itemId);
        }
      }
    }
  }
  if (sectionKey === "unscheduled") {
    ids.push(...sectionIds);
  } else {
    for (const item of buckets.unscheduled) {
      ids.push(item.itemId);
    }
  }
  return ids;
}
