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
 * Normalize + validate a patch's optional Instant fields and full-replace details.
 * Does not build a full item — used by Dynamo UpdateExpression (never touches sortKey).
 */
export function resolveItemPatchFields(
  existing: ItineraryItem,
  patch: UpdateItineraryItem,
): {
  readonly title?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly startTimeZone?: string;
  readonly endTimeZone?: string;
  readonly startLocation?: ItineraryItem["startLocation"];
  readonly endLocation?: ItineraryItem["endLocation"];
  readonly notes?: string;
  readonly confirmationCode?: string;
  readonly enrichment?: ItineraryItem["enrichment"];
  readonly details?: ItineraryItem["details"];
} {
  const out: {
    title?: string;
    startAt?: string;
    endAt?: string;
    startTimeZone?: string;
    endTimeZone?: string;
    startLocation?: ItineraryItem["startLocation"];
    endLocation?: ItineraryItem["endLocation"];
    notes?: string;
    confirmationCode?: string;
    enrichment?: ItineraryItem["enrichment"];
    details?: ItineraryItem["details"];
  } = {};

  if (patch.title !== undefined) {
    out.title = patch.title;
  }
  if (patch.startAt !== undefined) {
    out.startAt = normalizeOptionalInstant(patch.startAt, "startAt");
  }
  if (patch.endAt !== undefined) {
    out.endAt = normalizeOptionalInstant(patch.endAt, "endAt");
  }
  if (patch.startTimeZone !== undefined) {
    out.startTimeZone = patch.startTimeZone;
  }
  if (patch.endTimeZone !== undefined) {
    out.endTimeZone = patch.endTimeZone;
  }
  if (patch.startLocation !== undefined) {
    out.startLocation = patch.startLocation;
  }
  if (patch.endLocation !== undefined) {
    out.endLocation = patch.endLocation;
  }
  if (patch.notes !== undefined) {
    out.notes = patch.notes;
  }
  if (patch.confirmationCode !== undefined) {
    out.confirmationCode = patch.confirmationCode;
  }
  if (patch.enrichment !== undefined) {
    out.enrichment = patch.enrichment;
  }
  if (patch.details !== undefined) {
    const decoded = decodeUpdateDetails(existing.type, patch.details);
    if (Either.isLeft(decoded)) {
      throw AppError.validation("Request validation failed", {
        issues: String(decoded.left),
        field: "details",
      });
    }
    out.details = decoded.right as ItineraryItem["details"];
  }
  return out;
}

/**
 * Build DynamoDB UpdateExpression for an item PATCH.
 * **Never includes sortKey** so concurrent reorders are not clobbered.
 */
export function buildItemPatchUpdateExpression(
  existing: ItineraryItem,
  patch: UpdateItineraryItem,
  expectedVersion: number,
  now: string = nowInstant(),
): {
  readonly updateExpression: string;
  readonly expressionAttributeNames: Record<string, string>;
  readonly expressionAttributeValues: Record<string, unknown>;
  readonly newVersion: number;
  readonly updatedAt: string;
} {
  const fields = resolveItemPatchFields(existing, patch);
  const newVersion = existing.version + 1;
  const names: Record<string, string> = { "#ver": "version" };
  const values: Record<string, unknown> = {
    ":nv": newVersion,
    ":ev": expectedVersion,
    ":ua": now,
  };
  const sets: string[] = ["#ver = :nv", "updatedAt = :ua"];

  if (fields.title !== undefined) {
    sets.push("title = :title");
    values[":title"] = fields.title;
  }
  if (fields.startAt !== undefined) {
    sets.push("startAt = :startAt");
    values[":startAt"] = fields.startAt;
  }
  if (fields.endAt !== undefined) {
    sets.push("endAt = :endAt");
    values[":endAt"] = fields.endAt;
  }
  if (fields.startTimeZone !== undefined) {
    sets.push("startTimeZone = :startTimeZone");
    values[":startTimeZone"] = fields.startTimeZone;
  }
  if (fields.endTimeZone !== undefined) {
    sets.push("endTimeZone = :endTimeZone");
    values[":endTimeZone"] = fields.endTimeZone;
  }
  if (fields.startLocation !== undefined) {
    sets.push("startLocation = :startLocation");
    values[":startLocation"] = fields.startLocation;
  }
  if (fields.endLocation !== undefined) {
    sets.push("endLocation = :endLocation");
    values[":endLocation"] = fields.endLocation;
  }
  if (fields.notes !== undefined) {
    sets.push("notes = :notes");
    values[":notes"] = fields.notes;
  }
  if (fields.confirmationCode !== undefined) {
    sets.push("confirmationCode = :confirmationCode");
    values[":confirmationCode"] = fields.confirmationCode;
  }
  if (fields.enrichment !== undefined) {
    sets.push("enrichment = :enrichment");
    values[":enrichment"] = fields.enrichment;
  }
  if (fields.details !== undefined) {
    sets.push("details = :details");
    values[":details"] = fields.details;
  }

  return {
    updateExpression: `SET ${sets.join(", ")}`,
    expressionAttributeNames: names,
    expressionAttributeValues: values,
    newVersion,
    updatedAt: now,
  };
}

/**
 * Apply a validated update patch to an existing item (in-memory path).
 * `type` is immutable (rejected by UpdateItineraryItem schema).
 * `details` is full-replace when present (validated against stored type).
 * **Preserves `sortKey` from `existing`** — callers must pass the live row
 * (or re-apply live sortKey after write) so reorder races are not clobbered.
 */
export function applyItemPatch(
  existing: ItineraryItem,
  patch: UpdateItineraryItem,
  now: string = nowInstant(),
): ItineraryItem {
  const fields = resolveItemPatchFields(existing, patch);

  const nextBase = {
    itemId: existing.itemId,
    tripId: existing.tripId,
    title: fields.title ?? existing.title,
    // Never take sortKey from the client — keep live value from existing.
    sortKey: existing.sortKey,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: now,
    startAt: fields.startAt !== undefined ? fields.startAt : existing.startAt,
    endAt: fields.endAt !== undefined ? fields.endAt : existing.endAt,
    startTimeZone:
      fields.startTimeZone !== undefined
        ? fields.startTimeZone
        : existing.startTimeZone,
    endTimeZone:
      fields.endTimeZone !== undefined
        ? fields.endTimeZone
        : existing.endTimeZone,
    startLocation:
      fields.startLocation !== undefined
        ? fields.startLocation
        : existing.startLocation,
    endLocation:
      fields.endLocation !== undefined
        ? fields.endLocation
        : existing.endLocation,
    notes: fields.notes !== undefined ? fields.notes : existing.notes,
    confirmationCode:
      fields.confirmationCode !== undefined
        ? fields.confirmationCode
        : existing.confirmationCode,
    enrichment:
      fields.enrichment !== undefined
        ? fields.enrichment
        : existing.enrichment,
  };

  const details = fields.details ?? existing.details;
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
