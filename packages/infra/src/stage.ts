/**
 * Deployment stage for TripPlan stacks.
 * Passed via CDK context: `cdk synth -c stage=dev` (default: dev).
 *
 * Closed union only — typos like `production` / `Prod` fail synth rather than
 * silently deploying without PITR / deletion protection.
 */
export const STAGES = ["dev", "staging", "prod"] as const;

export type Stage = (typeof STAGES)[number];

export function resolveStage(raw: unknown): Stage {
  if (raw === undefined || raw === null || raw === "") {
    return "dev";
  }
  if (typeof raw === "string") {
    const stage = raw.trim();
    if ((STAGES as readonly string[]).includes(stage)) {
      return stage as Stage;
    }
    throw new Error(
      `Invalid stage "${stage}". Expected one of: ${STAGES.join(", ")}.`,
    );
  }
  throw new Error(
    `Invalid stage ${JSON.stringify(raw)}. Expected one of: ${STAGES.join(", ")}.`,
  );
}

export function isProdStage(stage: Stage): boolean {
  return stage === "prod";
}
