/**
 * @tripplan/domain — pure types, schemas, and domain logic.
 */

export const DOMAIN_PACKAGE = "@tripplan/domain" as const;

export * from "./instant.js";
export * from "./geo.js";
export * from "./enrichment.js";
export * from "./itinerary-item.js";
export * from "./trip.js";
export * from "./user.js";
export * from "./share.js";
export * from "./attachment.js";
export * from "./errors.js";
export * from "./day-bucket.js";
