import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { isProdStage, type Stage } from "../stage.js";

export interface DataStackProps extends cdk.StackProps {
  readonly stage: Stage;
}

/**
 * Browser origins allowed to PUT/GET documents via presigned URLs.
 * Stage-driven so a dedicated staging host can be added without touching prod.
 *
 * Attachment object keys (design): `trips/{tripId}/items/{itemId}/{attachmentId}`
 * — not under a `pending/` prefix. Pending state is DDB `status: pending` + object tag.
 */
function docsCorsOrigins(stage: Stage): string[] {
  const productionSpa = "https://plan.ericminassian.com";
  const stagingSpa = "https://plan-staging.ericminassian.com";
  const localVite = "http://localhost:5173";

  switch (stage) {
    case "prod":
      // Design requires prod SPA + local Vite for dogfood/dev against real bucket.
      return [productionSpa, localVite];
    case "staging":
      return [stagingSpa, productionSpa, localVite];
    case "dev":
      return [productionSpa, localVite];
  }
}

/**
 * Data plane: single-table DynamoDB (GSI1–4 + TTL) and encrypted S3 docs bucket.
 * PITR + deletion protection enabled only for prod stage.
 */
export class DataStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly documentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const prod = isProdStage(stage);

    this.table = new dynamodb.Table(this, "TripPlanTable", {
      tableName: `TripPlan-${stage}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // DynamoDB TTL attribute (epoch seconds). Used for sessions, idempotency keys, enrich cache.
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: prod,
      },
      // Blocks console/API DeleteTable on prod (RETAIN alone does not).
      deletionProtection: prod,
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // GSI1 — Trip by id (GSI1PK=TRIP#tripId, GSI1SK=META)
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "ownerId",
        "title",
        "timezone",
        "startDate",
        "endDate",
        "version",
        "deletedAt",
        "status",
      ],
    });

    // GSI2 — Share token lookup (GSI2PK=SHARETOKEN#sha256, GSI2SK=TRIP#tripId)
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "shareId",
        "revoked",
        "expiresAt",
        "tripId",
        "ownerId",
      ],
    });

    // GSI3 — Sessions by trip (trip delete purge). KEYS_ONLY.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI3",
      partitionKey: { name: "GSI3PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI4 — Sessions by share grant (revoke purge). KEYS_ONLY.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI4",
      partitionKey: { name: "GSI4PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI4SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: undefined, // CDK-generated unique name; export via outputs
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: docsCorsOrigins(stage),
          allowedHeaders: [
            "Content-Type",
            "Content-Length",
            "Content-MD5",
            "x-amz-checksum-crc32",
            "x-amz-sdk-checksum-algorithm",
            "x-amz-content-sha256",
            "x-amz-date",
            "x-amz-security-token",
            "x-amz-tagging",
            "authorization",
          ],
          exposedHeaders: ["ETag", "x-amz-version-id"],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          id: "AbortIncompleteMultipartUploads",
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          enabled: true,
        },
        {
          // Design key layout: trips/{tripId}/items/{itemId}/{attachmentId} (no pending/ prefix).
          // PR14 must tag unconfirmed PUT objects with pending=true (signed x-amz-tagging on
          // presign) and remove/clear the tag on confirm. Abandoned objects then expire in 1 day
          // (aligns with 24h DDB pending TTL). Trip delete worker still purges trips/{tripId}/.
          id: "ExpirePendingTaggedUploads",
          tagFilters: { pending: "true" },
          expiration: cdk.Duration.days(1),
          enabled: true,
        },
      ],
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });

    new cdk.CfnOutput(this, "TableName", {
      value: this.table.tableName,
      description: "TripPlan single-table DynamoDB name",
      exportName: `tripplan-${stage}-table-name`,
    });

    new cdk.CfnOutput(this, "TableArn", {
      value: this.table.tableArn,
      description: "TripPlan single-table DynamoDB ARN",
      exportName: `tripplan-${stage}-table-arn`,
    });

    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value: this.documentsBucket.bucketName,
      description: "S3 documents bucket name",
      exportName: `tripplan-${stage}-docs-bucket-name`,
    });

    new cdk.CfnOutput(this, "DocumentsBucketArn", {
      value: this.documentsBucket.bucketArn,
      description: "S3 documents bucket ARN",
      exportName: `tripplan-${stage}-docs-bucket-arn`,
    });
  }
}
