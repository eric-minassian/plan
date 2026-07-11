import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { isProdStage, type Stage } from "../stage.js";

export interface FoundationStackProps extends cdk.StackProps {
  readonly stage: Stage;
}

/**
 * Foundation plane: log retention defaults and Secrets Manager placeholders.
 * Ops replaces generated secret values after deploy (AeroDataBox, MapTiler server key).
 * No Cognito / AuthStack — OIDC lives in the external auth repo.
 */
export class FoundationStack extends cdk.Stack {
  /** Default CloudWatch log retention for this stage (consumed by later stacks). */
  readonly defaultLogRetention: logs.RetentionDays;

  readonly aeroDataBoxSecret: secretsmanager.Secret;
  readonly mapTilerSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const prod = isProdStage(stage);

    // Dev/staging: 1 month keeps cost low; prod: 1 year for ops/debug.
    this.defaultLogRetention = prod
      ? logs.RetentionDays.ONE_YEAR
      : logs.RetentionDays.ONE_MONTH;

    // Shared application log group with stage-appropriate retention.
    // Future Lambda/API stacks can write here or use the same retention value.
    new logs.LogGroup(this, "ApplicationLogGroup", {
      logGroupName: `/tripplan/${stage}/application`,
      retention: this.defaultLogRetention,
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Placeholder secrets via generateSecretString so CFN does not own a static
    // SecretString that would overwrite ops-filled values on template drift.
    // After first deploy, set real credentials only via Secrets Manager APIs
    // (put-secret-value) — never bake live keys into CDK source.
    this.aeroDataBoxSecret = new secretsmanager.Secret(
      this,
      "AeroDataBoxSecret",
      {
        secretName: `tripplan/${stage}/aerodatabox`,
        description:
          "AeroDataBox (flight enrichment) API credentials. Replace generated apiKey after deploy via put-secret-value.",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            host: "aerodatabox.p.rapidapi.com",
          }),
          generateStringKey: "apiKey",
          excludePunctuation: true,
          passwordLength: 32,
        },
        removalPolicy: prod
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      },
    );

    this.mapTilerSecret = new secretsmanager.Secret(this, "MapTilerSecret", {
      secretName: `tripplan/${stage}/maptiler`,
      description:
        "MapTiler server-side key (geocoding). Browser tile key is referrer-restricted and may live in web config instead. Replace generated apiKey after deploy via put-secret-value.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "apiKey",
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, "AeroDataBoxSecretArn", {
      value: this.aeroDataBoxSecret.secretArn,
      description: "ARN of AeroDataBox secret (replace generated apiKey after deploy)",
      exportName: `tripplan-${stage}-aerodatabox-secret-arn`,
    });

    new cdk.CfnOutput(this, "MapTilerSecretArn", {
      value: this.mapTilerSecret.secretArn,
      description: "ARN of MapTiler server secret (replace generated apiKey after deploy)",
      exportName: `tripplan-${stage}-maptiler-secret-arn`,
    });

    new cdk.CfnOutput(this, "DefaultLogRetentionDays", {
      value: String(this.defaultLogRetention),
      description: "Default CloudWatch log retention (days) for this stage",
      exportName: `tripplan-${stage}-default-log-retention-days`,
    });
  }
}
