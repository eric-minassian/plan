import {
  CreateTrip,
  Trip,
  type CreateTrip as CreateTripInput,
  type Trip as TripType,
} from "@tripplan/domain";
import { Either, Schema as S } from "effect";
import { ApiClientError } from "./errors.ts";

/** Trip list page DTO (matches OpenAPI TripListResponse). */
export const TripListResponseSchema = S.Struct({
  trips: S.Array(Trip),
  nextCursor: S.optional(S.String),
});
export type TripListResponse = typeof TripListResponseSchema.Type;

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
