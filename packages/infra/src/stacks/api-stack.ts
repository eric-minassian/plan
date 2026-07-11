import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  OutputFormat,
} from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
  /** Optional log retention from FoundationStack (defaults by stage). */
  readonly logRetention?: logs.RetentionDays;
  /**
   * MapTiler server secret (FoundationStack). When set, grants read and injects
   * `MAPTILER_API_KEY` for live place geocoding. Live flag still defaults off
   * (`ENRICHMENT_PLACES_LIVE`) until ops enables it.
   */
  readonly mapTilerSecret?: secretsmanager.ISecret;
  /**
   * AeroDataBox secret (FoundationStack). When set, grants read and injects
   * `AERODATABOX_API_KEY` / `AERODATABOX_HOST` for live flight enrich.
   */
  readonly aeroDataBoxSecret?: secretsmanager.ISecret;
}

/**
 * API plane: Lambda (Node ARM64) + HTTP API.
 * JWT is verified in-Lambda via `@ericminassian/auth` — no Cognito, no
 * API Gateway JWT authorizer on owner routes.
 *
 * Persistence: `TABLE_NAME` + Dynamo R/W grants enable trip meta CRUD
 * (`USER#ownerId` / `TRIP#tripId` + GSI1). User profile upsert remains
 * in-memory until a Dynamo UserRepository lands.
 */
export class ApiStack extends cdk.Stack {
  readonly httpApi: apigwv2.HttpApi;
  readonly apiFunction: lambda.Function;
  readonly httpApiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, table } = props;
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

    const publicApiBaseUrl = publicApiBaseUrlForStage(stage);

    // Live enrich flags default false (mock). Ops can flip via Lambda env /
    // parameter after secrets are filled — CDK does not force live on.
    const secretEnv: Record<string, string> = {};
    if (props.mapTilerSecret !== undefined) {
      secretEnv["MAPTILER_API_KEY"] = props.mapTilerSecret
        .secretValueFromJson("apiKey")
        .unsafeUnwrap();
    }
    if (props.aeroDataBoxSecret !== undefined) {
      secretEnv["AERODATABOX_API_KEY"] = props.aeroDataBoxSecret
        .secretValueFromJson("apiKey")
        .unsafeUnwrap();
      secretEnv["AERODATABOX_HOST"] = props.aeroDataBoxSecret
        .secretValueFromJson("host")
        .unsafeUnwrap();
    }

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
        AUTH_ISSUER: "https://auth.ericminassian.com",
        AUTH_AUDIENCE: "plan",
        STAGE: stage,
        // Trusted origin for DPoP htu (not client X-Forwarded-Host).
        ...(publicApiBaseUrl !== undefined
          ? { PUBLIC_API_BASE_URL: publicApiBaseUrl }
          : {}),
        // Mock-default; set true only after vendor TOS + secret fill.
        ENRICHMENT_PLACES_LIVE: "false",
        ENRICHMENT_FLIGHT_LIVE: "false",
        ...secretEnv,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // Keep Effect + auth SDK in the bundle so Lambda has no node_modules layout issues.
        externalModules: ["@aws-sdk/*"],
      },
      description: `TripPlan HTTP API (${stage}) — health, me, owner trip CRUD`,
    });

    // R/W for trip meta (and future profile) single-table access.
    table.grantReadWriteData(this.apiFunction);

    // Server-side enrichment secrets (MapTiler places, AeroDataBox flights).
    props.mapTilerSecret?.grantRead(this.apiFunction);
    props.aeroDataBoxSecret?.grantRead(this.apiFunction);

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
      methods: [apigwv2.HttpMethod.GET],
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
