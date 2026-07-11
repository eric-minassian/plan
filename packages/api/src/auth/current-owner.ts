import { Context } from "effect";
import type { OwnerPrincipal } from "./owner-principal.js";

/**
 * Principal established once by the owner authz gate.
 * Handlers must read this instead of calling `requireOwner()` again
 * (avoids double JWT/DPoP verification and DPoP jti replay false positives).
 */
export class CurrentOwner extends Context.Tag("CurrentOwner")<
  CurrentOwner,
  OwnerPrincipal
>() {}
