import { Context } from "effect";
import type { SharePrincipal } from "./share-auth.js";

/**
 * Principal established once by the share authz gate.
 * Handlers must read this instead of calling `requireShare()` again.
 */
export class CurrentShare extends Context.Tag("CurrentShare")<
  CurrentShare,
  SharePrincipal
>() {}
