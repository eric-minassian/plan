import { Context } from "effect";
import type { AuthClass, HttpRequest } from "./types.js";

export interface RequestContextValue {
  readonly request: HttpRequest;
  readonly authClass: AuthClass;
}

export class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  RequestContextValue
>() {}
