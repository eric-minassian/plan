/**
 * @tripplan/infra — AWS CDK stacks for TripPlan (us-east-1).
 *
 * Current: FoundationStack + DataStack + ApiStack + WebStack.
 * Later: ObservabilityStack (no Cognito/AuthStack).
 */
export {
  apiCorsOrigins,
  defaultSpaDomain,
  docsCorsOrigins,
  LOCAL_VITE_ORIGIN,
  PROD_SPA_DOMAIN,
  spaOriginForStage,
  STAGING_SPA_DOMAIN,
} from "./hosts.js";
export { ApiStack, type ApiStackProps } from "./stacks/api-stack.js";
export { DataStack, type DataStackProps } from "./stacks/data-stack.js";
export {
  FoundationStack,
  type FoundationStackProps,
} from "./stacks/foundation-stack.js";
export {
  buildContentSecurityPolicy,
  resolveWebDomain,
  SPA_ROUTER_FUNCTION_CODE,
  WebStack,
  type WebStackProps,
} from "./stacks/web-stack.js";
export {
  isProdStage,
  resolveStage,
  STAGES,
  type Stage,
} from "./stage.js";
