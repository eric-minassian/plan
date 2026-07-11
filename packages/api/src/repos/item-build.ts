/**
 * Build / patch itinerary items at the API boundary (Instant normalize, details replace).
 */
import {
  InstantParseError,
  decodeUpdateDetails,
  normalizeInstant,
  type CreateItineraryItem,
  type ItineraryItem,
  type ItemType,
  type UpdateItineraryItem,
} from "@tripplan/domain";
import { Either } from "effect";
import { AppError } from "../errors/app-error.js";

function normalizeOptionalInstant(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return normalizeInstant(value);
  } catch (e) {
    if (e instanceof InstantParseError) {
      throw AppError.validation(`Invalid ${field}: must be RFC 3339 with zone`);
    }
    throw e;
  }
}

function nowInstant(): string {
  return normalizeInstant(new Date().toISOString());
}

/**
 * Construct a new ItineraryItem from a create DTO.
 * Server assigns itemId, sortKey, version, timestamps; normalizes Instant fields.
 */
export function buildCreatedItem(
  tripId: string,
  input: CreateItineraryItem,
  sortKey: number,
  itemId: string = crypto.randomUUID(),
  now: string = nowInstant(),
): ItineraryItem {
  const startAt = normalizeOptionalInstant(input.startAt, "startAt");
  const endAt = normalizeOptionalInstant(input.endAt, "endAt");

  const base = {
    itemId,
    tripId,
    title: input.title,
    sortKey,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    ...(input.startTimeZone !== undefined
      ? { startTimeZone: input.startTimeZone }
      : {}),
    ...(input.endTimeZone !== undefined
      ? { endTimeZone: input.endTimeZone }
      : {}),
    ...(input.startLocation !== undefined
      ? { startLocation: input.startLocation }
      : {}),
    ...(input.endLocation !== undefined
      ? { endLocation: input.endLocation }
      : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.confirmationCode !== undefined
      ? { confirmationCode: input.confirmationCode }
      : {}),
    ...(input.enrichment !== undefined ? { enrichment: input.enrichment } : {}),
  };

  // Discriminated union: type + details already validated by CreateItineraryItem.
  switch (input.type) {
    case "flight":
      return { ...base, type: "flight", details: input.details };
    case "train":
      return { ...base, type: "train", details: input.details };
    case "hotel":
      return { ...base, type: "hotel", details: input.details };
    case "transport":
      return { ...base, type: "transport", details: input.details };
    case "activity":
      return { ...base, type: "activity", details: input.details };
    case "ticket":
      return { ...base, type: "ticket", details: input.details };
    case "note":
      return { ...base, type: "note", details: input.details };
    case "custom":
      return { ...base, type: "custom", details: input.details };
  }
}

/**
 * Apply a validated update patch to an existing item.
 * `type` is immutable (rejected by UpdateItineraryItem schema).
 * `details` is full-replace when present (validated against stored type).
 */
export function applyItemPatch(
  existing: ItineraryItem,
  patch: UpdateItineraryItem,
  now: string = nowInstant(),
): ItineraryItem {
  const startAt =
    patch.startAt !== undefined
      ? normalizeOptionalInstant(patch.startAt, "startAt")
      : existing.startAt;
  const endAt =
    patch.endAt !== undefined
      ? normalizeOptionalInstant(patch.endAt, "endAt")
      : existing.endAt;

  let details = existing.details;
  if (patch.details !== undefined) {
    const decoded = decodeUpdateDetails(existing.type, patch.details);
    if (Either.isLeft(decoded)) {
      throw AppError.validation("Request validation failed", {
        issues: String(decoded.left),
        field: "details",
      });
    }
    details = decoded.right as ItineraryItem["details"];
  }

  const nextBase = {
    itemId: existing.itemId,
    tripId: existing.tripId,
    title: patch.title ?? existing.title,
    sortKey: existing.sortKey,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: now,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    startTimeZone:
      patch.startTimeZone !== undefined
        ? patch.startTimeZone
        : existing.startTimeZone,
    endTimeZone:
      patch.endTimeZone !== undefined
        ? patch.endTimeZone
        : existing.endTimeZone,
    startLocation:
      patch.startLocation !== undefined
        ? patch.startLocation
        : existing.startLocation,
    endLocation:
      patch.endLocation !== undefined
        ? patch.endLocation
        : existing.endLocation,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    confirmationCode:
      patch.confirmationCode !== undefined
        ? patch.confirmationCode
        : existing.confirmationCode,
    enrichment:
      patch.enrichment !== undefined
        ? patch.enrichment
        : existing.enrichment,
  };

  // Strip undefined optionals so JSON/Dynamo stay clean.
  const cleaned = stripUndefined(nextBase);

  return withTypeAndDetails(cleaned, existing.type, details);
}

function stripUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function withTypeAndDetails(
  base: Record<string, unknown>,
  type: ItemType,
  details: ItineraryItem["details"],
): ItineraryItem {
  switch (type) {
    case "flight":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "flight",
        details: details as Extract<ItineraryItem, { type: "flight" }>["details"],
      };
    case "train":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "train",
        details: details as Extract<ItineraryItem, { type: "train" }>["details"],
      };
    case "hotel":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "hotel",
        details: details as Extract<ItineraryItem, { type: "hotel" }>["details"],
      };
    case "transport":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "transport",
        details: details as Extract<
          ItineraryItem,
          { type: "transport" }
        >["details"],
      };
    case "activity":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "activity",
        details: details as Extract<
          ItineraryItem,
          { type: "activity" }
        >["details"],
      };
    case "ticket":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "ticket",
        details: details as Extract<ItineraryItem, { type: "ticket" }>["details"],
      };
    case "note":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "note",
        details: details as Extract<ItineraryItem, { type: "note" }>["details"],
      };
    case "custom":
      return {
        ...(base as Omit<ItineraryItem, "type" | "details">),
        type: "custom",
        details: details as Extract<ItineraryItem, { type: "custom" }>["details"],
      };
  }
}
