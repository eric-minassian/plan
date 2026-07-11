import { Context, type Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import type { OwnerPrincipal } from "./owner-principal.js";

/**
 * Owner auth boundary (design AuthProvider).
 * Production: `@ericminassian/auth` verifier (DPoP auto).
 * Tests: inject a fixed principal without the IdP.
 */
export interface OwnerAuthService {
  /**
   * Verify the current request's owner credentials.
   * Fails with Unauthorized (401) when missing/invalid/expired.
   */
  readonly requireOwner: () => Effect.Effect<OwnerPrincipal, AppError>;
}

export class OwnerAuth extends Context.Tag("OwnerAuth")<
  OwnerAuth,
  OwnerAuthService
>() {}
