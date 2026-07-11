import { Schema as S } from "effect";
import { Instant } from "./instant.js";

export const UserProfile = S.Struct({
  userId: S.String,
  iss: S.String,
  displayName: S.String,
  createdAt: Instant,
});
export type UserProfile = typeof UserProfile.Type;

export const UpdateUserProfile = S.Struct({
  displayName: S.String.pipe(S.minLength(1), S.maxLength(200)),
});
export type UpdateUserProfile = typeof UpdateUserProfile.Type;
