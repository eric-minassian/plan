/**
 * Stable day-colored palette for map markers and filter chips.
 * Cycles when a trip has more days than colors.
 */

const DAY_COLORS = [
  "#5b9fd4",
  "#7bc96f",
  "#e0b45a",
  "#c58af9",
  "#f07178",
  "#56b6c2",
  "#d19a66",
  "#61afef",
] as const;

const UNSCHEDULED_COLOR = "#9aa7b5";

/** Color for a trip-relative day number (1-based). */
export function colorForDayNumber(dayNumber: number): string {
  if (!Number.isFinite(dayNumber) || dayNumber < 1) {
    return UNSCHEDULED_COLOR;
  }
  const index = (Math.floor(dayNumber) - 1) % DAY_COLORS.length;
  const color = DAY_COLORS[index];
  return color ?? UNSCHEDULED_COLOR;
}

export function colorForUnscheduled(): string {
  return UNSCHEDULED_COLOR;
}

export { UNSCHEDULED_COLOR };
