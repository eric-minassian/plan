import { Schema as S } from "effect";
import { Instant } from "./instant.js";

/** Civil date YYYY-MM-DD (trip start/end in trip timezone). */
export const CivilDate = S.String.pipe(
  S.pattern(/^\d{4}-\d{2}-\d{2}$/),
);
export type CivilDate = typeof CivilDate.Type;

export const TripStatus = S.Literal("active", "deleting", "deleted");
export type TripStatus = typeof TripStatus.Type;

export const Trip = S.Struct({
  tripId: S.String,
  ownerId: S.String,
  title: S.String.pipe(S.minLength(1), S.maxLength(200)),
  /** IANA timezone — default day-bucket zone. */
  timezone: S.String,
  startDate: CivilDate,
  endDate: CivilDate,
  version: S.Number,
  status: TripStatus,
  deletedAt: S.optional(Instant),
});
export type Trip = typeof Trip.Type;

export const CreateTrip = S.Struct({
  title: S.String.pipe(S.minLength(1), S.maxLength(200)),
  timezone: S.String,
  startDate: CivilDate,
  endDate: CivilDate,
});
export type CreateTrip = typeof CreateTrip.Type;

export const UpdateTrip = S.Struct({
  title: S.optional(S.String.pipe(S.minLength(1), S.maxLength(200))),
  timezone: S.optional(S.String),
  startDate: S.optional(CivilDate),
  endDate: S.optional(CivilDate),
});
export type UpdateTrip = typeof UpdateTrip.Type;
