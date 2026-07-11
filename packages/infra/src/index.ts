/**
 * @tripplan/infra — AWS CDK stacks for TripPlan (us-east-1).
 *
 * Current: FoundationStack + DataStack + ApiStack + ObservabilityStack.
 * Later: WebStack (no Cognito/AuthStack).
 */
export { ApiStack, type ApiStackProps } from "./stacks/api-stack.js";
export { DataStack, type DataStackProps } from "./stacks/data-stack.js";
export {
  FoundationStack,
  type FoundationStackProps,
} from "./stacks/foundation-stack.js";
export {
  API_5XX_MIN_REQUESTS,
  API_P95_ALARM_THRESHOLD_MS,
  API_P95_DESIGN_TARGET_MS,
  ObservabilityStack,
  TRIPPLAN_METRIC_NAMESPACE,
  type ObservabilityStackProps,
} from "./stacks/observability-stack.js";
export {
  isProdStage,
  resolveStage,
  STAGES,
  type Stage,
} from "./stage.js";
