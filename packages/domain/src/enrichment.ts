import { Schema as S } from "effect";
import { Instant } from "./instant.js";

export const EnrichmentMeta = S.Struct({
  provider: S.String,
  fetchedAt: Instant,
  confidence: S.optional(S.Number),
  rawRef: S.optional(S.String),
});
export type EnrichmentMeta = typeof EnrichmentMeta.Type;
