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
