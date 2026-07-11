import { Schema as S } from "effect";
import { Instant } from "./instant.js";
import { isValidCivilDateParts, isValidIanaTimeZone } from "./time.js";

/** Civil date YYYY-MM-DD with real calendar components (rejects 2024-13-40, Feb 30). */
export const CivilDate = S.String.pipe(
  S.pattern(/^\d{4}-\d{2}-\d{2}$/),
  S.filter(
    (s) => {
      const year = Number(s.slice(0, 4));
      const month = Number(s.slice(5, 7));
      const day = Number(s.slice(8, 10));
      return isValidCivilDateParts(year, month, day);
    },
    { message: () => "Invalid civil date (YYYY-MM-DD must be a real calendar day)" },
  ),
);
export type CivilDate = typeof CivilDate.Type;

/** IANA timezone identifier validated via Intl. */
export const IanaTimeZone = S.String.pipe(
  S.filter(isValidIanaTimeZone, {
    message: () => "Invalid IANA time zone",
  }),
);
export type IanaTimeZone = typeof IanaTimeZone.Type;

export const TripStatus = S.Literal("active", "deleting", "deleted");
export type TripStatus = typeof TripStatus.Type;

export const Trip = S.Struct({
  tripId: S.String,
  ownerId: S.String,
  title: S.String.pipe(S.minLength(1), S.maxLength(200)),
  /** IANA timezone — default day-bucket zone. */
  timezone: IanaTimeZone,
  startDate: CivilDate,
  endDate: CivilDate,
  version: S.Number,
  status: TripStatus,
  deletedAt: S.optional(Instant),
});
export type Trip = typeof Trip.Type;

export const CreateTrip = S.Struct({
  title: S.String.pipe(S.minLength(1), S.maxLength(200)),
  timezone: IanaTimeZone,
  startDate: CivilDate,
  endDate: CivilDate,
});
export type CreateTrip = typeof CreateTrip.Type;

export const UpdateTrip = S.Struct({
  title: S.optional(S.String.pipe(S.minLength(1), S.maxLength(200))),
  timezone: S.optional(IanaTimeZone),
  startDate: S.optional(CivilDate),
  endDate: S.optional(CivilDate),
});
export type UpdateTrip = typeof UpdateTrip.Type;
