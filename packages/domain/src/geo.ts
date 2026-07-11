import { Schema as S } from "effect";

export const GeoPoint = S.Struct({
  lat: S.Number.pipe(S.between(-90, 90)),
  lng: S.Number.pipe(S.between(-180, 180)),
  label: S.optional(S.String),
  placeId: S.optional(S.String),
  address: S.optional(S.String),
  /** IANA timezone for this location (display / local context). */
  timezone: S.optional(S.String),
});
export type GeoPoint = typeof GeoPoint.Type;
