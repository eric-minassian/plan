import { Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import type { OwnerAuthService } from "./owner-auth.js";
import type { OwnerPrincipal } from "./owner-principal.js";

/**
 * Test double: always returns a fixed principal (or fails Unauthorized).
 * Inject into the Effect layer so `/me` and owner middleware can be unit-tested
 * without the IdP or JWKS.
 */
export function makeMockOwnerAuth(
  principal: OwnerPrincipal | null,
): OwnerAuthService {
  return {
    requireOwner: () => {
      if (principal === null) {
        return Effect.fail(AppError.unauthorized("Authentication required"));
      }
      return Effect.succeed(principal);
    },
  };
}

export function mockPrincipal(
  overrides: Partial<OwnerPrincipal> & Pick<OwnerPrincipal, "sub">,
): OwnerPrincipal {
  return {
    iss: overrides.iss ?? "https://auth.ericminassian.com",
    nickname: overrides.nickname,
    sid: overrides.sid,
    scope: overrides.scope ?? "openid profile offline_access",
    jti: overrides.jti,
    acr: overrides.acr,
    claims: overrides.claims ?? { sub: overrides.sub },
    sub: overrides.sub,
  };
}
