import {
  CreateItineraryItem,
  CreateTrip,
  FlightEnrichmentResponse,
  ItineraryItem,
  Trip,
  UpdateItineraryItem,
  type CreateItineraryItem as CreateItineraryItemInput,
  type CreateTrip as CreateTripInput,
  type FlightEnrichmentResponse as FlightEnrichmentResponseType,
  type ItineraryItem as ItineraryItemType,
  type Trip as TripType,
  type UpdateItineraryItem as UpdateItineraryItemInput,
} from "@tripplan/domain";
import { Either, Schema as S } from "effect";
import { ApiClientError } from "./errors.ts";

/** Trip list page DTO (matches OpenAPI TripListResponse). */
export const TripListResponseSchema = S.Struct({
  trips: S.Array(Trip),
  nextCursor: S.optional(S.String),
});
export type TripListResponse = typeof TripListResponseSchema.Type;

/** GET /trips/:id — meta + items ordered by sortKey. */
export const TripDetailResponseSchema = S.Struct({
  ...Trip.fields,
  items: S.Array(ItineraryItem),
});
export type TripDetailResponse = typeof TripDetailResponseSchema.Type;

function schemaIssues(error: unknown): string {
  return String(error);
}

/** Decode create-trip form payload with domain schema (IANA tz + civil dates). */
export function decodeCreateTrip(
  input: unknown,
): Either.Either<CreateTripInput, string> {
  const decoded = S.decodeUnknownEither(CreateTrip)(input);
  if (Either.isLeft(decoded)) {
    return Either.left(schemaIssues(decoded.left));
  }
  return Either.right(decoded.right);
}

/**
 * Decode create-item form payload (flight / note in PR 8b; other types accepted
 * by the domain schema if needed later).
 */
export function decodeCreateItem(
  input: unknown,
): Either.Either<CreateItineraryItemInput, string> {
  const decoded = S.decodeUnknownEither(CreateItineraryItem)(input);
  if (Either.isLeft(decoded)) {
    return Either.left(schemaIssues(decoded.left));
  }
  return Either.right(decoded.right);
}

/** Decode partial item patch; rejects payloads that include immutable `type`. */
export function decodeUpdateItem(
  input: unknown,
): Either.Either<UpdateItineraryItemInput, string> {
  const decoded = S.decodeUnknownEither(UpdateItineraryItem)(input);
  if (Either.isLeft(decoded)) {
    return Either.left(schemaIssues(decoded.left));
  }
  return Either.right(decoded.right);
}

/** Decode a single trip; throws {@link ApiClientError} on shape mismatch. */
export function decodeTripResponse(
  json: unknown,
  status: number,
): TripType {
  const decoded = S.decodeUnknownEither(Trip)(json);
  if (Either.isLeft(decoded)) {
    throw new ApiClientError(
      status,
      undefined,
      `Invalid trip response: ${schemaIssues(decoded.left)}`,
    );
  }
  return decoded.right;
}

/** Decode trip list body; throws {@link ApiClientError} on shape mismatch. */
export function decodeTripListResponse(
  json: unknown,
  status: number,
): TripListResponse {
  const decoded = S.decodeUnknownEither(TripListResponseSchema)(json);
  if (Either.isLeft(decoded)) {
    throw new ApiClientError(
      status,
      undefined,
      `Invalid trip list response: ${schemaIssues(decoded.left)}`,
    );
  }
  return decoded.right;
}

/** Decode trip detail (meta + items); throws {@link ApiClientError} on mismatch. */
export function decodeTripDetailResponse(
  json: unknown,
  status: number,
): TripDetailResponse {
  const decoded = S.decodeUnknownEither(TripDetailResponseSchema)(json);
  if (Either.isLeft(decoded)) {
    throw new ApiClientError(
      status,
      undefined,
      `Invalid trip detail response: ${schemaIssues(decoded.left)}`,
    );
  }
  return decoded.right;
}

/** Decode a single itinerary item; throws {@link ApiClientError} on mismatch. */
export function decodeItemResponse(
  json: unknown,
  status: number,
): ItineraryItemType {
  const decoded = S.decodeUnknownEither(ItineraryItem)(json);
  if (Either.isLeft(decoded)) {
    throw new ApiClientError(
      status,
      undefined,
      `Invalid item response: ${schemaIssues(decoded.left)}`,
    );
  }
  return decoded.right;
}

/** Decode flight enrichment DTO (found / cancelled / not_found). */
export function decodeFlightEnrichmentResponse(
  json: unknown,
  status: number,
): FlightEnrichmentResponseType {
  const decoded = S.decodeUnknownEither(FlightEnrichmentResponse)(json);
  if (Either.isLeft(decoded)) {
    throw new ApiClientError(
      status,
      undefined,
      `Invalid flight enrichment response: ${schemaIssues(decoded.left)}`,
    );
  }
  return decoded.right;
}

/** Format integer version as opaque quoted If-Match / ETag value. */
export function etagFromVersion(version: number): string {
  return `"${String(version)}"`;
}
