#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DataStack } from "../src/stacks/data-stack.js";
import { FoundationStack } from "../src/stacks/foundation-stack.js";
import { isProdStage, resolveStage } from "../src/stage.js";

/**
 * TripPlan CDK app — Foundation + Data stacks only (us-east-1).
 * Stage via context: `pnpm synth -c stage=dev` (default: dev).
 * Allowed stages: dev | staging | prod (unknown values fail synth).
 */
const app = new cdk.App();

const stage = resolveStage(app.node.tryGetContext("stage"));
const prod = isProdStage(stage);
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "us-east-1",
};

const foundation = new FoundationStack(app, `TripPlan-Foundation-${stage}`, {
  env,
  stage,
  description: `TripPlan foundation (secrets, log defaults) — ${stage}`,
  terminationProtection: prod,
  tags: {
    Project: "TripPlan",
    Stage: stage,
    Stack: "Foundation",
  },
});

const data = new DataStack(app, `TripPlan-Data-${stage}`, {
  env,
  stage,
  description: `TripPlan data plane (DynamoDB + S3 docs) — ${stage}`,
  terminationProtection: prod,
  tags: {
    Project: "TripPlan",
    Stage: stage,
    Stack: "Data",
  },
});

// Explicit dependency for deploy ordering (data may later consume foundation outputs).
data.addDependency(foundation);

app.synth();
