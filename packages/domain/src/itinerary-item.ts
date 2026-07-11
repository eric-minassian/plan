import { Schema as S } from "effect";
import { EnrichmentMeta } from "./enrichment.js";
import { GeoPoint } from "./geo.js";
import { Instant, InstantInput } from "./instant.js";

const Title = S.String.pipe(S.minLength(1), S.maxLength(200));
const Notes = S.String.pipe(S.maxLength(5000));
const ConfirmationCode = S.String.pipe(S.maxLength(64));

/** Shared fields present on every itinerary item. */
const ItemBaseFields = {
  itemId: S.String,
  tripId: S.String,
  title: Title,
  startAt: S.optional(Instant),
  endAt: S.optional(Instant),
  startTimeZone: S.optional(S.String),
  endTimeZone: S.optional(S.String),
  startLocation: S.optional(GeoPoint),
  endLocation: S.optional(GeoPoint),
  /**
   * Free-form notes on any item type.
   * For type:"note", this IS the note body.
   */
  notes: S.optional(Notes),
  /**
   * Owner-facing PNR / confirmation shown on the card.
   * Prefer details.bookingReference for provider-specific codes when both exist;
   * confirmationCode is the single UI “Confirmation #” field when only one is needed.
   */
  confirmationCode: S.optional(ConfirmationCode),
  sortKey: S.Number,
  version: S.Number,
  enrichment: S.optional(EnrichmentMeta),
  createdAt: Instant,
  updatedAt: Instant,
};

export const FlightDetails = S.Struct({
  airlineCode: S.optional(S.String),
  airlineName: S.optional(S.String),
  flightNumber: S.String,
  departureAirport: S.optional(S.String),
  arrivalAirport: S.optional(S.String),
  departureTerminal: S.optional(S.String),
  arrivalTerminal: S.optional(S.String),
  /** Airline PNR if distinct from confirmationCode. */
  bookingReference: S.optional(S.String),
  seat: S.optional(S.String),
  cabin: S.optional(S.String),
  operatedBy: S.optional(S.String),
});
export type FlightDetails = typeof FlightDetails.Type;

export const HotelDetails = S.Struct({
  propertyName: S.String,
  checkInTime: S.optional(S.String),
  checkOutTime: S.optional(S.String),
  address: S.optional(S.String),
  phone: S.optional(S.String),
  bookingReference: S.optional(S.String),
  roomType: S.optional(S.String),
  timePrecision: S.optional(S.Literal("date", "datetime")),
});
export type HotelDetails = typeof HotelDetails.Type;

export const TrainDetails = S.Struct({
  operator: S.optional(S.String),
  trainNumber: S.optional(S.String),
  departureStation: S.optional(S.String),
  arrivalStation: S.optional(S.String),
  coach: S.optional(S.String),
  seat: S.optional(S.String),
  bookingReference: S.optional(S.String),
});
export type TrainDetails = typeof TrainDetails.Type;

export const TransportDetails = S.Struct({
  mode: S.Literal("car", "taxi", "rideshare", "bus", "ferry", "other"),
  provider: S.optional(S.String),
  pickupInstructions: S.optional(S.String),
});
export type TransportDetails = typeof TransportDetails.Type;

export const ActivityDetails = S.Struct({
  category: S.optional(S.String),
  venueName: S.optional(S.String),
  bookingUrl: S.optional(S.String),
  bookingReference: S.optional(S.String),
});
export type ActivityDetails = typeof ActivityDetails.Type;

export const TicketDetails = S.Struct({
  issuer: S.optional(S.String),
  ticketType: S.optional(S.String),
  validFrom: S.optional(Instant),
  validTo: S.optional(Instant),
});
export type TicketDetails = typeof TicketDetails.Type;

/**
 * Note items: body lives in base `notes`; details must be an empty object.
 * Effect's default Struct keeps unknown keys, so we filter to require emptiness.
 */
export const NoteDetails = S.Struct({}).pipe(
  S.filter((r) => Object.keys(r).length === 0, {
    message: () => "NoteDetails must be empty; put the note body in base notes",
  }),
);
export type NoteDetails = typeof NoteDetails.Type;

export const MAX_CUSTOM_FIELDS = 20 as const;
export const MAX_CUSTOM_FIELD_KEY_LENGTH = 64 as const;
export const MAX_CUSTOM_FIELD_VALUE_LENGTH = 200 as const;

/**
 * Custom field map. Effect Schema Record drops keys that fail the key schema,
 * so key length and field-count caps are enforced with an explicit filter.
 */
export const CustomFields = S.Record({
  key: S.String,
  value: S.String,
}).pipe(
  S.filter(
    (r) => {
      const keys = Object.keys(r);
      if (keys.length > MAX_CUSTOM_FIELDS) return false;
      for (const key of keys) {
        if (key.length > MAX_CUSTOM_FIELD_KEY_LENGTH) return false;
        const value = r[key];
        if (value === undefined || value.length > MAX_CUSTOM_FIELD_VALUE_LENGTH) {
          return false;
        }
      }
      return true;
    },
    {
      message: () =>
        `custom fields: max ${MAX_CUSTOM_FIELDS} keys, key ≤${MAX_CUSTOM_FIELD_KEY_LENGTH}, value ≤${MAX_CUSTOM_FIELD_VALUE_LENGTH}`,
    },
  ),
);
export type CustomFields = typeof CustomFields.Type;

export const CustomDetails = S.Struct({
  fields: S.optional(CustomFields),
});
export type CustomDetails = typeof CustomDetails.Type;

export const ItemType = S.Literal(
  "flight",
  "train",
  "hotel",
  "transport",
  "activity",
  "ticket",
  "note",
  "custom",
);
export type ItemType = typeof ItemType.Type;

export const FlightItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("flight"),
  details: FlightDetails,
});
export const TrainItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("train"),
  details: TrainDetails,
});
export const HotelItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("hotel"),
  details: HotelDetails,
});
export const TransportItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("transport"),
  details: TransportDetails,
});
export const ActivityItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("activity"),
  details: ActivityDetails,
});
export const TicketItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("ticket"),
  details: TicketDetails,
});
export const NoteItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("note"),
  details: NoteDetails,
});
export const CustomItem = S.Struct({
  ...ItemBaseFields,
  type: S.Literal("custom"),
  details: CustomDetails,
});

export const ItineraryItem = S.Union(
  FlightItem,
  TrainItem,
  HotelItem,
  TransportItem,
  ActivityItem,
  TicketItem,
  NoteItem,
  CustomItem,
);
export type ItineraryItem = typeof ItineraryItem.Type;

/** Client-facing optional fields shared by create variants (server fields omitted). */
const CreateSharedFields = {
  title: Title,
  startAt: S.optional(InstantInput),
  endAt: S.optional(InstantInput),
  startTimeZone: S.optional(S.String),
  endTimeZone: S.optional(S.String),
  startLocation: S.optional(GeoPoint),
  endLocation: S.optional(GeoPoint),
  notes: S.optional(Notes),
  confirmationCode: S.optional(ConfirmationCode),
  enrichment: S.optional(EnrichmentMeta),
};

/**
 * Create DTO: omits server-assigned fields
 * (`itemId`, `tripId`, `version`, `createdAt`, `updatedAt`, `sortKey`).
 * Times may be InstantInput; normalize at the API boundary.
 */
export const CreateItineraryItem = S.Union(
  S.Struct({ ...CreateSharedFields, type: S.Literal("flight"), details: FlightDetails }),
  S.Struct({ ...CreateSharedFields, type: S.Literal("train"), details: TrainDetails }),
  S.Struct({ ...CreateSharedFields, type: S.Literal("hotel"), details: HotelDetails }),
  S.Struct({
    ...CreateSharedFields,
    type: S.Literal("transport"),
    details: TransportDetails,
  }),
  S.Struct({
    ...CreateSharedFields,
    type: S.Literal("activity"),
    details: ActivityDetails,
  }),
  S.Struct({ ...CreateSharedFields, type: S.Literal("ticket"), details: TicketDetails }),
  S.Struct({ ...CreateSharedFields, type: S.Literal("note"), details: NoteDetails }),
  S.Struct({ ...CreateSharedFields, type: S.Literal("custom"), details: CustomDetails }),
);
export type CreateItineraryItem = typeof CreateItineraryItem.Type;

/**
 * Instant string to set, or JSON `null` to clear the stored field.
 * Omitted property ⇒ leave unchanged.
 */
const InstantPatch = S.NullOr(InstantInput);

/**
 * Update field struct (no `type`). Used after rejecting payloads that include `type`.
 */
/**
 * Enrichment meta to set, or JSON `null` to clear stored enrichment
 * (e.g. after a failed re-lookup on edit). Omitted ⇒ leave unchanged.
 */
const EnrichmentPatch = S.NullOr(EnrichmentMeta);

const UpdateItineraryItemFields = S.Struct({
  title: S.optional(Title),
  startAt: S.optional(InstantPatch),
  endAt: S.optional(InstantPatch),
  startTimeZone: S.optional(S.String),
  endTimeZone: S.optional(S.String),
  startLocation: S.optional(GeoPoint),
  endLocation: S.optional(GeoPoint),
  notes: S.optional(Notes),
  confirmationCode: S.optional(ConfirmationCode),
  enrichment: S.optional(EnrichmentPatch),
  /**
   * Full replace of details for the item's existing type.
   * Prefer {@link decodeUpdateDetails} with the stored item type.
   */
  details: S.optional(S.Unknown),
});

/**
 * Update DTO: partial patch. `type` is immutable — change type by delete + create.
 * Sending `type` fails decode with message suitable for 400 ValidationError.
 * When `details` is present it must match the existing item type schema
 * (full replace of details, not deep-merge) — use {@link decodeUpdateDetails}.
 * `startAt` / `endAt` / `enrichment`: Instant/meta to set, `null` to clear, omit to leave.
 */
export const UpdateItineraryItem = S.Unknown.pipe(
  S.filter(
    (u) =>
      typeof u === "object" &&
      u !== null &&
      !Array.isArray(u) &&
      !("type" in u),
    { message: () => "type is immutable; delete and recreate" },
  ),
  S.compose(UpdateItineraryItemFields),
);
export type UpdateItineraryItem = typeof UpdateItineraryItem.Type;

/** Typed update details helpers for service-layer validation. */
export const DetailsByType = {
  flight: FlightDetails,
  train: TrainDetails,
  hotel: HotelDetails,
  transport: TransportDetails,
  activity: ActivityDetails,
  ticket: TicketDetails,
  note: NoteDetails,
  custom: CustomDetails,
} as const;

export type DetailsForType<T extends ItemType> = S.Schema.Type<
  (typeof DetailsByType)[T]
>;

/**
 * Decode a full-replace `details` payload against the stored item's type schema.
 * Prefer this over trusting `UpdateItineraryItem.details` as `Unknown`.
 */
export function decodeUpdateDetails(
  type: ItemType,
  details: unknown,
) {
  switch (type) {
    case "flight":
      return S.decodeUnknownEither(FlightDetails)(details);
    case "train":
      return S.decodeUnknownEither(TrainDetails)(details);
    case "hotel":
      return S.decodeUnknownEither(HotelDetails)(details);
    case "transport":
      return S.decodeUnknownEither(TransportDetails)(details);
    case "activity":
      return S.decodeUnknownEither(ActivityDetails)(details);
    case "ticket":
      return S.decodeUnknownEither(TicketDetails)(details);
    case "note":
      return S.decodeUnknownEither(NoteDetails)(details);
    case "custom":
      return S.decodeUnknownEither(CustomDetails)(details);
  }
}
