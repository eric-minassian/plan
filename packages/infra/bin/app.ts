#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ApiStack } from "../src/stacks/api-stack.js";
import { DataStack } from "../src/stacks/data-stack.js";
import { FoundationStack } from "../src/stacks/foundation-stack.js";
import { WebStack } from "../src/stacks/web-stack.js";
import { isProdStage, resolveStage } from "../src/stage.js";

/**
 * TripPlan CDK app — Foundation + Data + Api + Web stacks (us-east-1).
 * Stage via context: `pnpm synth -c stage=dev` (default: dev).
 * Allowed stages: dev | staging | prod (unknown values fail synth).
 * No Cognito — owner OIDC is external (auth.ericminassian.com).
 *
 * Web / CloudFront context (all optional for synth):
 * - `webDomain` — custom hostname (defaults: prod plan.ericminassian.com,
 *   staging plan-staging…, dev none). Empty string disables custom domain.
 * - `certificateArn` — ACM cert ARN in us-east-1 (required for aliases)
 * - `hostedZoneId` + `hostedZoneName` — optional Route53 alias records
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

const api = new ApiStack(app, `TripPlan-Api-${stage}`, {
  env,
  stage,
  table: data.table,
  logRetention: foundation.defaultLogRetention,
  mapTilerSecret: foundation.mapTilerSecret,
  aeroDataBoxSecret: foundation.aeroDataBoxSecret,
  description: `TripPlan API (Lambda + HTTP API, in-Lambda OIDC) — ${stage}`,
  terminationProtection: prod,
  tags: {
    Project: "TripPlan",
    Stage: stage,
    Stack: "Api",
  },
});

api.addDependency(data);
api.addDependency(foundation);

const web = new WebStack(app, `TripPlan-Web-${stage}`, {
  env,
  stage,
  httpApiUrl: api.httpApiUrl,
  documentsBucketDomainName: data.documentsBucket.bucketRegionalDomainName,
  // Raw context: undefined → stage default; "" → no custom domain.
  domainName: contextString(app, "webDomain"),
  certificateArn: contextString(app, "certificateArn"),
  hostedZoneId: contextString(app, "hostedZoneId"),
  hostedZoneName: contextString(app, "hostedZoneName"),
  description: `TripPlan web (CloudFront SPA + /api proxy + CSP) — ${stage}`,
  terminationProtection: prod,
  tags: {
    Project: "TripPlan",
    Stage: stage,
    Stack: "Web",
  },
});

web.addDependency(api);
web.addDependency(data);

app.synth();

/** Read optional string CDK context; missing key → undefined. */
function contextString(app: cdk.App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(
    `CDK context "${key}" must be a string, got ${typeof value}`,
  );
}
