import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  OutputFormat,
} from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { apiCorsOrigins, spaOriginForStage } from "../hosts.js";
import { isProdStage, type Stage } from "../stage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ApiStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** Single-table DynamoDB from DataStack. */
  readonly table: dynamodb.ITable;
  /** Documents bucket for presigned attachment PUT/GET. */
  readonly documentsBucket: s3.IBucket;
  /** Optional log retention from FoundationStack (defaults by stage). */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * API plane: Lambda (Node ARM64) + HTTP API + trip-delete SQS worker.
 * JWT is verified in-Lambda via `@ericminassian/auth` — no Cognito, no
 * API Gateway JWT authorizer on owner routes.
 *
 * Persistence: `TABLE_NAME` + Dynamo R/W grants enable trip/item/share/ATT rows.
 * `DOCS_BUCKET_NAME` + S3 R/W for presigned attachments (HeadObject, tags, delete).
 * `TRIP_DELETE_QUEUE_URL` + SQS send for async trip cascade delete.
 * User profile upsert remains in-memory until a Dynamo UserRepository lands.
 */
export class ApiStack extends cdk.Stack {
  readonly httpApi: apigwv2.HttpApi;
  readonly apiFunction: lambda.Function;
  readonly tripDeleteWorker: lambda.Function;
  readonly tripDeleteQueue: sqs.Queue;
  /** DLQ for ObservabilityStack (`deleteDlq` prop). */
  readonly deleteDlq: sqs.Queue;
  readonly httpApiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, table, documentsBucket } = props;
    const prod = isProdStage(stage);
    const logRetention =
      props.logRetention ??
      (prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH);

    // packages/api/src/handler.ts relative to this file:
    // stacks/ -> src/ -> infra/ -> packages/ -> api/src/handler.ts
    const apiHandlerEntry = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "api",
      "src",
      "handler.ts",
    );
    const tripDeleteWorkerEntry = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "api",
      "src",
      "workers",
      "trip-delete-worker.ts",
    );

    const publicApiBaseUrl = publicApiBaseUrlForStage(stage);

    // Dead-letter queue first so main queue can reference it.
    // Visibility timeout 5m on main queue (worker timeout ≤ 4m leaves headroom).
    this.deleteDlq = new sqs.Queue(this, "TripDeleteDlq", {
      queueName: `tripplan-trip-delete-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.tripDeleteQueue = new sqs.Queue(this, "TripDeleteQueue", {
      queueName: `tripplan-trip-delete-${stage}`,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.deleteDlq,
        maxReceiveCount: 5,
      },
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Minimal ops signal until ObservabilityStack wires full dashboards (PR17).
    new cloudwatch.Alarm(this, "TripDeleteDlqDepthAlarm", {
      alarmName: `tripplan-${stage}-delete-dlq-depth`,
      alarmDescription:
        "Trip-delete DLQ has visible messages — cascade failed after maxReceiveCount",
      metric: this.deleteDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const commonBundling = {
      minify: true,
      sourceMap: true,
      target: "node22",
      format: OutputFormat.ESM,
      mainFields: ["module", "main"] as string[],
      banner:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      externalModules: ["@aws-sdk/*"],
    };

    this.apiFunction = new NodejsFunction(this, "ApiHandler", {
      functionName: `tripplan-api-${stage}`,
      entry: apiHandlerEntry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(29),
      tracing: lambda.Tracing.ACTIVE,
      logRetention,
      environment: {
        TABLE_NAME: table.tableName,
        DOCS_BUCKET_NAME: documentsBucket.bucketName,
        TRIP_DELETE_QUEUE_URL: this.tripDeleteQueue.queueUrl,
        AUTH_ISSUER: "https://auth.ericminassian.com",
        AUTH_AUDIENCE: "plan",
        STAGE: stage,
        // Trusted origin for DPoP htu (not client X-Forwarded-Host).
        ...(publicApiBaseUrl !== undefined
          ? { PUBLIC_API_BASE_URL: publicApiBaseUrl }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: commonBundling,
      description: `TripPlan HTTP API (${stage}) — trips, items, shares, attachments`,
    });

    // Worker: cascade sessions (GSI3) + TRIP# partition + S3 prefix + status=deleted.
    // Timeout 4m < queue visibility 5m so in-flight messages are not redelivered mid-run.
    this.tripDeleteWorker = new NodejsFunction(this, "TripDeleteWorker", {
      functionName: `tripplan-trip-delete-${stage}`,
      entry: tripDeleteWorkerEntry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(4),
      tracing: lambda.Tracing.ACTIVE,
      logRetention,
      environment: {
        TABLE_NAME: table.tableName,
        DOCS_BUCKET_NAME: documentsBucket.bucketName,
        STAGE: stage,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: commonBundling,
      description: `TripPlan trip-delete cascade worker (${stage})`,
    });

    this.tripDeleteWorker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.tripDeleteQueue, {
        batchSize: 1,
        reportBatchItemFailures: false,
      }),
    );

    // R/W for trip/item/share/ATT single-table access (API + worker).
    table.grantReadWriteData(this.apiFunction);
    table.grantReadWriteData(this.tripDeleteWorker);
    // Presign is SigV4 (no IAM on client); Lambda needs HeadObject, tagging, delete.
    documentsBucket.grantReadWrite(this.apiFunction);
    documentsBucket.grantReadWrite(this.tripDeleteWorker);
    // Tagging for pending=true lifecycle (IBucket has no .grant helper).
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:PutObjectTagging",
          "s3:GetObjectTagging",
          "s3:DeleteObjectTagging",
        ],
        resources: [documentsBucket.arnForObjects("*")],
      }),
    );
    // API enqueues cascade; worker consumes (event source grant covers receive/delete).
    this.tripDeleteQueue.grantSendMessages(this.apiFunction);

    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `tripplan-${stage}`,
      description: `TripPlan HTTP API (${stage}). Owner JWT verified in Lambda; no Cognito.`,
      corsPreflight: {
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "DPoP",
          "If-Match",
          "Idempotency-Key",
          "X-Request-Id",
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: corsOrigins(stage),
        maxAge: cdk.Duration.hours(1),
        allowCredentials: true,
      },
      // No default authorizer — Public/Share/Owner matrix is enforced in Lambda.
    });

    const integration = new integrations.HttpLambdaIntegration(
      "ApiIntegration",
      this.apiFunction,
      {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      },
    );

    // Public — no JWT authorizer at the gateway
    this.httpApi.addRoutes({
      path: "/api/v1/health",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    // Owner — JWT verified in Lambda (OIDC), not Cognito / APIGW JWT authorizer
    this.httpApi.addRoutes({
      path: "/api/v1/me",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration,
    });

    // Catch-all under /api/v1/* so future routes (trips, share, enrich) hit the
    // same Lambda without a blanket JWT policy. Auth class is decided in-process.
    this.httpApi.addRoutes({
      path: "/api/v1/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
    });

    this.httpApiUrl = this.httpApi.apiEndpoint;

    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: this.httpApiUrl,
      description: "HTTP API base URL (no trailing slash)",
      exportName: `tripplan-${stage}-http-api-url`,
    });

    new cdk.CfnOutput(this, "ApiFunctionName", {
      value: this.apiFunction.functionName,
      description: "API Lambda function name",
      exportName: `tripplan-${stage}-api-function-name`,
    });

    new cdk.CfnOutput(this, "TripDeleteQueueUrl", {
      value: this.tripDeleteQueue.queueUrl,
      description: "Trip-delete SQS queue URL",
      exportName: `tripplan-${stage}-trip-delete-queue-url`,
    });

    new cdk.CfnOutput(this, "TripDeleteDlqUrl", {
      value: this.deleteDlq.queueUrl,
      description: "Trip-delete DLQ URL (ObservabilityStack deleteDlq)",
      exportName: `tripplan-${stage}-trip-delete-dlq-url`,
    });

    new cdk.CfnOutput(this, "TripDeleteWorkerName", {
      value: this.tripDeleteWorker.functionName,
      description: "Trip-delete cascade worker Lambda name",
      exportName: `tripplan-${stage}-trip-delete-worker-name`,
    });
  }
}

/**
 * CORS: prod/staging only their stage SPA host (credentialed share cookies must
 * not be readable from arbitrary localhost pages against non-dev APIs).
 * Dev keeps Vite local. Origins shared via `apiCorsOrigins` in hosts.ts.
 */
function corsOrigins(stage: Stage): string[] {
  return apiCorsOrigins(stage);
}

/**
 * Trusted public origin for DPoP `htu` reconstruction.
 * Dev leaves unset so Lambda uses API Gateway `Host` (execute-api URL).
 * Staging/prod use the stage SPA host (same CloudFront public host as /api).
 */
function publicApiBaseUrlForStage(stage: Stage): string | undefined {
  return spaOriginForStage(stage);
}
