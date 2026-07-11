import { Context } from "effect";
import type { AuthClass, HttpRequest } from "./types.js";

export interface RequestContextValue {
  readonly request: HttpRequest;
  readonly authClass: AuthClass;
  /** Captured `:param` segments from the matched route pattern. */
  readonly pathParams: Readonly<Record<string, string>>;
}

export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  RequestContextValue
>() {}
