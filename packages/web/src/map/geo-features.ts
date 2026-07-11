import type { GeoPoint, ItineraryItem } from "@tripplan/domain";
import { civilDateDiffDays, civilDateInTimeZone } from "@tripplan/domain";
import type { AirportsIndex } from "./airports.ts";
import { emptyAirportsIndex } from "./airports.ts";
import { colorForDayNumber, colorForUnscheduled } from "./day-colors.ts";

export type MapPinRole = "start" | "end";

export type MapPin = {
  readonly id: string;
  readonly itemId: string;
  readonly role: MapPinRole;
  readonly lng: number;
  readonly lat: number;
  readonly label: string;
  /** Civil date YYYY-MM-DD in trip TZ, or null if unscheduled. */
  readonly dayKey: string | null;
  readonly dayNumber: number | null;
  readonly color: string;
  readonly itemType: ItineraryItem["type"];
  readonly title: string;
};

export type MapArc = {
  readonly id: string;
  readonly itemId: string;
  readonly from: { readonly lng: number; readonly lat: number };
  readonly to: { readonly lng: number; readonly lat: number };
  readonly dayKey: string | null;
  readonly dayNumber: number | null;
  readonly color: string;
  readonly title: string;
};

/** Sentinel dayKey for unscheduled items with geo (filter chip). */
export const UNSCHEDULED_DAY_KEY = "__unscheduled__" as const;

export type MapDayFilter = {
  readonly dayKey: string;
  readonly dayNumber: number;
  readonly label: string;
  readonly color: string;
  readonly pinCount: number;
};

export type TripMapModel = {
  readonly pins: readonly MapPin[];
  readonly arcs: readonly MapArc[];
  readonly days: readonly MapDayFilter[];
  /** Pin count for items with no civil day (shown via Unscheduled chip). */
  readonly unscheduledPinCount: number;
  /** True when at least one pin exists. */
  readonly hasGeo: boolean;
};

export type BuildTripMapModelOptions = {
  readonly items: readonly ItineraryItem[];
  readonly tripTimezone: string;
  readonly tripStartDate: string;
  readonly airports?: AirportsIndex;
};

/**
 * Build map pins/arcs from itinerary items.
 * - Explicit `startLocation` / `endLocation` win.
 * - Flights fall back to IATA resolve via the airports index.
 * - Items with no resolvable geo are omitted (timeline-only).
 */
export function buildTripMapModel(
  options: BuildTripMapModelOptions,
): TripMapModel {
  const airports = options.airports ?? emptyAirportsIndex();
  const pins: MapPin[] = [];
  const arcs: MapArc[] = [];
  const dayPinCounts = new Map<
    string,
    { dayNumber: number; count: number }
  >();
  let unscheduledPinCount = 0;

  for (const item of options.items) {
    const day = dayContext(
      item,
      options.tripTimezone,
      options.tripStartDate,
    );
    const color =
      day.dayNumber !== null
        ? colorForDayNumber(day.dayNumber)
        : colorForUnscheduled();

    const start = resolveStartPoint(item, airports);
    const end = resolveEndPoint(item, airports);

    if (start !== undefined) {
      const pin = toPin(item, "start", start, day, color);
      pins.push(pin);
      if (day.dayKey === null) {
        unscheduledPinCount += 1;
      } else {
        bumpDay(dayPinCounts, day);
      }
    }
    if (end !== undefined) {
      // Skip duplicate end pin when it is the same coordinate as start
      // (hotel-style single location on both fields).
      const sameAsStart =
        start !== undefined &&
        nearlySame(start.lat, start.lng, end.lat, end.lng);
      if (!sameAsStart) {
        const pin = toPin(item, "end", end, day, color);
        pins.push(pin);
        if (day.dayKey === null) {
          unscheduledPinCount += 1;
        } else {
          bumpDay(dayPinCounts, day);
        }
      }
    }

    if (
      start !== undefined &&
      end !== undefined &&
      !nearlySame(start.lat, start.lng, end.lat, end.lng)
    ) {
      arcs.push({
        id: `${item.itemId}:arc`,
        itemId: item.itemId,
        from: { lng: start.lng, lat: start.lat },
        to: { lng: end.lng, lat: end.lat },
        dayKey: day.dayKey,
        dayNumber: day.dayNumber,
        color,
        title: item.title,
      });
    }
  }

  const days: MapDayFilter[] = [...dayPinCounts.entries()]
    .map(([dayKey, meta]) => ({
      dayKey,
      dayNumber: meta.dayNumber,
      label: `Day ${String(meta.dayNumber)}`,
      color: colorForDayNumber(meta.dayNumber),
      pinCount: meta.count,
    }))
    .sort(
      (a, b) =>
        a.dayNumber - b.dayNumber || a.dayKey.localeCompare(b.dayKey),
    );

  return {
    pins,
    arcs,
    days,
    unscheduledPinCount,
    hasGeo: pins.length > 0,
  };
}

/**
 * Filter pins/arcs by selected day keys.
 * - Empty / null selection ⇒ all.
 * - {@link UNSCHEDULED_DAY_KEY} includes pins/arcs with `dayKey === null`.
 */
export function filterMapModel(
  model: TripMapModel,
  selectedDayKeys: ReadonlySet<string> | null,
): { readonly pins: readonly MapPin[]; readonly arcs: readonly MapArc[] } {
  if (selectedDayKeys === null || selectedDayKeys.size === 0) {
    return { pins: model.pins, arcs: model.arcs };
  }
  const includeUnscheduled = selectedDayKeys.has(UNSCHEDULED_DAY_KEY);
  return {
    pins: model.pins.filter((p) => {
      if (p.dayKey === null) {
        return includeUnscheduled;
      }
      return selectedDayKeys.has(p.dayKey);
    }),
    arcs: model.arcs.filter((a) => {
      if (a.dayKey === null) {
        return includeUnscheduled;
      }
      return selectedDayKeys.has(a.dayKey);
    }),
  };
}

/** Stable key for trip geo bbox changes (ignore day filters). */
export function mapFitBoundsKey(pins: readonly MapPin[]): string {
  if (pins.length === 0) {
    return "";
  }
  return pins
    .map((p) => `${p.id}:${p.lat.toFixed(5)}:${p.lng.toFixed(5)}`)
    .sort()
    .join("|");
}

export type ResolvedPoint = {
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
  readonly source: "location" | "iata";
};

export function resolveStartPoint(
  item: ItineraryItem,
  airports: AirportsIndex,
): ResolvedPoint | undefined {
  const fromLoc = fromGeoPoint(item.startLocation);
  if (fromLoc !== undefined) {
    return fromLoc;
  }
  if (item.type === "flight") {
    return fromIata(item.details.departureAirport, airports);
  }
  return undefined;
}

export function resolveEndPoint(
  item: ItineraryItem,
  airports: AirportsIndex,
): ResolvedPoint | undefined {
  const fromLoc = fromGeoPoint(item.endLocation);
  if (fromLoc !== undefined) {
    return fromLoc;
  }
  if (item.type === "flight") {
    return fromIata(item.details.arrivalAirport, airports);
  }
  return undefined;
}

/** Whether an item has any map-resolvable geo (for “Add location” badge). */
export function itemHasMapGeo(
  item: ItineraryItem,
  airports: AirportsIndex = emptyAirportsIndex(),
): boolean {
  return (
    resolveStartPoint(item, airports) !== undefined ||
    resolveEndPoint(item, airports) !== undefined
  );
}

function fromGeoPoint(point: GeoPoint | undefined): ResolvedPoint | undefined {
  if (point === undefined) {
    return undefined;
  }
  return {
    lat: point.lat,
    lng: point.lng,
    label: point.label ?? point.address ?? coordinatesLabel(point.lat, point.lng),
    source: "location",
  };
}

function fromIata(
  code: string | undefined,
  airports: AirportsIndex,
): ResolvedPoint | undefined {
  if (code === undefined || code.trim().length === 0) {
    return undefined;
  }
  const airport = airports.get(code);
  if (airport === undefined) {
    return undefined;
  }
  return {
    lat: airport.lat,
    lng: airport.lng,
    label: airport.name ?? airport.iata,
    source: "iata",
  };
}

function toPin(
  item: ItineraryItem,
  role: MapPinRole,
  point: ResolvedPoint,
  day: DayContext,
  color: string,
): MapPin {
  return {
    id: `${item.itemId}:${role}`,
    itemId: item.itemId,
    role,
    lng: point.lng,
    lat: point.lat,
    label: point.label,
    dayKey: day.dayKey,
    dayNumber: day.dayNumber,
    color,
    itemType: item.type,
    title: item.title,
  };
}

type DayContext = {
  readonly dayKey: string | null;
  readonly dayNumber: number | null;
};

function dayContext(
  item: ItineraryItem,
  tripTimezone: string,
  tripStartDate: string,
): DayContext {
  const startAt = item.startAt;
  if (startAt === undefined) {
    return { dayKey: null, dayNumber: null };
  }
  try {
    const dayKey = civilDateInTimeZone(startAt, tripTimezone);
    const dayNumber = civilDateDiffDays(tripStartDate, dayKey) + 1;
    return { dayKey, dayNumber };
  } catch {
    return { dayKey: null, dayNumber: null };
  }
}

function bumpDay(
  counts: Map<string, { dayNumber: number; count: number }>,
  day: DayContext,
): void {
  if (day.dayKey === null || day.dayNumber === null) {
    return;
  }
  const existing = counts.get(day.dayKey);
  if (existing === undefined) {
    counts.set(day.dayKey, { dayNumber: day.dayNumber, count: 1 });
  } else {
    counts.set(day.dayKey, {
      dayNumber: existing.dayNumber,
      count: existing.count + 1,
    });
  }
}

function nearlySame(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number,
): boolean {
  return Math.abs(latA - latB) < 1e-6 && Math.abs(lngA - lngB) < 1e-6;
}

function coordinatesLabel(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/**
 * Great-circle intermediate points for a flight arc (lng/lat pairs).
 * Includes endpoints; `segments` is the number of edge segments.
 *
 * Longitudes are **unwrapped** for continuity so consecutive points never
 * jump across the antimeridian (MapLibre would draw that segment the long way).
 * Values may fall outside [-180, 180]; that is intentional for rendering.
 */
export function greatCircleCoordinates(
  from: { readonly lng: number; readonly lat: number },
  to: { readonly lng: number; readonly lat: number },
  segments = 48,
): Array<[number, number]> {
  const λ1 = toRad(from.lng);
  const φ1 = toRad(from.lat);
  const λ2 = toRad(to.lng);
  const φ2 = toRad(to.lat);

  const cosφ1 = Math.cos(φ1);
  const cosφ2 = Math.cos(φ2);
  const x1 = cosφ1 * Math.cos(λ1);
  const y1 = cosφ1 * Math.sin(λ1);
  const z1 = Math.sin(φ1);
  const x2 = cosφ2 * Math.cos(λ2);
  const y2 = cosφ2 * Math.sin(λ2);
  const z2 = Math.sin(φ2);

  const dot = clamp(x1 * x2 + y1 * y2 + z1 * z2, -1, 1);
  const ω = Math.acos(dot);

  const coords: Array<[number, number]> = [];
  if (!Number.isFinite(ω) || ω < 1e-9) {
    coords.push([from.lng, from.lat], [to.lng, to.lat]);
    return unwrapLongitudes(coords);
  }

  const sinω = Math.sin(ω);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = Math.sin((1 - t) * ω) / sinω;
    const b = Math.sin(t * ω) / sinω;
    const x = a * x1 + b * x2;
    const y = a * y1 + b * y2;
    const z = a * z1 + b * z2;
    const φ = Math.atan2(z, Math.hypot(x, y));
    const λ = Math.atan2(y, x);
    coords.push([toDeg(λ), toDeg(φ)]);
  }
  return unwrapLongitudes(coords);
}

/**
 * Adjust consecutive longitudes so each step is the short way
 * (|Δlng| ≤ 180). Enables continuous arcs across the antimeridian.
 */
export function unwrapLongitudes(
  coords: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  if (coords.length === 0) {
    return [];
  }
  const first = coords[0];
  if (first === undefined) {
    return [];
  }
  const out: Array<[number, number]> = [[first[0], first[1]]];
  for (let i = 1; i < coords.length; i++) {
    const cur = coords[i];
    const prev = out[i - 1];
    if (cur === undefined || prev === undefined) {
      continue;
    }
    let lng = cur[0];
    const prevLng = prev[0];
    while (lng - prevLng > 180) {
      lng -= 360;
    }
    while (lng - prevLng < -180) {
      lng += 360;
    }
    out.push([lng, cur[1]]);
  }
  return out;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
