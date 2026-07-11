import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { defaultSpaDomain } from "../hosts.js";
import { isProdStage, type Stage } from "../stage.js";

const AUTH_ISSUER = "https://auth.ericminassian.com";
const AUTH_CLIENT_ID = "plan";

/**
 * CloudFront Function (viewer-request) for SPA client-side routes.
 * Rewrites extension-less paths to /index.html so we never need distribution-level
 * custom error responses (those would also rewrite /api/* 403/404 to HTML).
 * /api/* uses a separate behavior and never hits this function.
 */
export const SPA_ROUTER_FUNCTION_CODE = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // Keep real static files (assets, config.json, favicon, etc.).
  // Root "/" is handled by defaultRootObject.
  if (uri !== "/" && uri.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
`.trim();

export interface WebStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** HTTP API base URL from ApiStack (e.g. https://{id}.execute-api.us-east-1.amazonaws.com). */
  readonly httpApiUrl: string;
  /** Docs bucket regional domain for CSP connect-src (presigned GET/PUT). */
  readonly documentsBucketDomainName: string;
  /**
   * Custom SPA hostname. Defaults: prod → plan.ericminassian.com,
   * staging → plan-staging.ericminassian.com, dev → none (CloudFront domain only).
   * Override via CDK context `webDomain`.
   */
  readonly domainName?: string;
  /**
   * ACM certificate ARN in **us-east-1** (required for custom domain / aliases).
   * Pass via CDK context `certificateArn` so synth works without a real cert.
   */
  readonly certificateArn?: string;
  /**
   * Optional public hosted zone for alias records.
   * Context: `hostedZoneId` + `hostedZoneName` (e.g. ericminassian.com).
   */
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

/**
 * Web edge: private SPA bucket + CloudFront on the plan host.
 * - Default behavior: S3 SPA; viewer-request Function rewrites client routes
 * - `/api/*` → API Gateway HTTP API (true status codes; no SPA error remapping)
 * - `/config.json` → S3 with cache disabled
 * - Response headers policy: CSP for self, IdP, MapTiler, docs S3
 * - Runtime `/config.json` (authIssuer, authClientId, mapTilerApiKey placeholder)
 */
export class WebStack extends cdk.Stack {
  readonly spaBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly distributionDomainName: string;
  /** Custom domain when cert + domain configured; otherwise undefined. */
  readonly webDomainName: string | undefined;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { stage, httpApiUrl, documentsBucketDomainName } = props;
    const prod = isProdStage(stage);

    const domainName = resolveWebDomain(stage, props.domainName);
    const certificateArn = emptyToUndefined(props.certificateArn);
    const hostedZoneId = emptyToUndefined(props.hostedZoneId);
    const hostedZoneName = emptyToUndefined(props.hostedZoneName);

    this.webDomainName =
      domainName !== undefined && certificateArn !== undefined
        ? domainName
        : undefined;

    this.spaBucket = new s3.Bucket(this, "SpaBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      // Static assets are served only via CloudFront (OAC); no browser CORS needed.
      removalPolicy: prod
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });

    const certificate =
      certificateArn !== undefined
        ? acm.Certificate.fromCertificateArn(
            this,
            "CloudFrontCertificate",
            certificateArn,
          )
        : undefined;

    if (domainName !== undefined && certificate === undefined) {
      // Custom domain without cert → skip aliases so synth/deploy still work.
      // Documented in packages/infra/README.md.
      cdk.Annotations.of(this).addWarning(
        `webDomain "${domainName}" set without certificateArn; ` +
          "CloudFront will use the default *.cloudfront.net domain only. " +
          "Pass -c certificateArn=arn:aws:acm:us-east-1:…:certificate/… for aliases.",
      );
    }

    // httpApiUrl is a CFN token (e.g. https://{id}.execute-api…); parse via Fn.
    const apiOriginHostname = httpApiHostname(httpApiUrl);
    const apiOrigin = new origins.HttpOrigin(apiOriginHostname, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      // HTTP API has no stage path prefix beyond the URL host.
      httpsPort: 443,
      readTimeout: cdk.Duration.seconds(30),
    });

    const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      this.spaBucket,
    );

    const csp = buildContentSecurityPolicy(documentsBucketDomainName);

    const spaResponseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SpaResponseHeaders",
      {
        responseHeadersPolicyName: `tripplan-spa-${stage}`,
        comment: "CSP + baseline security headers for TripPlan SPA",
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: csp,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: false,
            override: true,
          },
        },
      },
    );

    // HSTS only on API paths — do not attach the HTML CSP to JSON responses.
    const apiResponseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "ApiResponseHeaders",
      {
        responseHeadersPolicyName: `tripplan-api-${stage}`,
        comment: "HSTS for /api/* (no CSP — API returns JSON)",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: false,
            override: true,
          },
          contentTypeOptions: { override: true },
        },
      },
    );

    const spaRouter = new cloudfront.Function(this, "SpaRouter", {
      functionName: `tripplan-spa-router-${stage}`,
      comment:
        "Rewrite extension-less SPA routes to /index.html (not applied to /api/*)",
      code: cloudfront.FunctionCode.fromInline(SPA_ROUTER_FUNCTION_CODE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `TripPlan SPA + /api proxy (${stage})`,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      // Certificate only when aliases are active (CF requires cert ↔ domainNames).
      domainNames:
        this.webDomainName !== undefined ? [this.webDomainName] : undefined,
      certificate:
        this.webDomainName !== undefined ? certificate : undefined,
      defaultBehavior: {
        origin: spaOrigin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: spaResponseHeaders,
        functionAssociations: [
          {
            function: spaRouter,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // Runtime config must not sit behind long-lived edge cache.
        "/config.json": {
          origin: spaOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: spaResponseHeaders,
        },
        // Same public host as SPA so share cookies stay first-party.
        // No custom error responses: API 403/404 must pass through as JSON.
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forward auth / DPoP / content headers; Host must be execute-api.
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: apiResponseHeaders,
        },
      },
      // Intentionally no distribution errorResponses mapping 403/404 → index.html.
      // That remaps /api/* errors. SPA routing is handled by SpaRouter Function.
    });

    this.distributionDomainName = this.distribution.distributionDomainName;

    // Runtime config for the SPA (not baked into the JS bundle).
    // mapTilerApiKey is a placeholder — replace after deploy (exclude from s3 sync).
    new s3deploy.BucketDeployment(this, "RuntimeConfig", {
      sources: [
        s3deploy.Source.data(
          "config.json",
          `${JSON.stringify(
            {
              authIssuer: AUTH_ISSUER,
              authClientId: AUTH_CLIENT_ID,
              mapTilerApiKey: "",
            },
            null,
            2,
          )}\n`,
        ),
      ],
      destinationBucket: this.spaBucket,
      distribution: this.distribution,
      distributionPaths: ["/config.json"],
      // Do not prune — SPA static assets are uploaded by a separate build step.
      prune: false,
      memoryLimit: 128,
      contentType: "application/json",
      cacheControl: [
        s3deploy.CacheControl.noCache(),
        s3deploy.CacheControl.mustRevalidate(),
      ],
    });

    if (
      this.webDomainName !== undefined &&
      hostedZoneId !== undefined &&
      hostedZoneName !== undefined
    ) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        "HostedZone",
        {
          hostedZoneId,
          zoneName: hostedZoneName,
        },
      );

      new route53.ARecord(this, "AliasA", {
        zone,
        recordName: this.webDomainName,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution),
        ),
      });

      new route53.AaaaRecord(this, "AliasAAAA", {
        zone,
        recordName: this.webDomainName,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution),
        ),
      });
    } else if (this.webDomainName !== undefined) {
      cdk.Annotations.of(this).addInfo(
        `Custom domain ${this.webDomainName} configured without hostedZoneId/hostedZoneName; ` +
          "create DNS alias to the CloudFront domain manually, or pass both zone context keys.",
      );
    }

    new cdk.CfnOutput(this, "SpaBucketName", {
      value: this.spaBucket.bucketName,
      description: "S3 bucket for SPA static assets (deploy dist/ here)",
      exportName: `tripplan-${stage}-spa-bucket-name`,
    });

    new cdk.CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront distribution ID",
      exportName: `tripplan-${stage}-distribution-id`,
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: this.distributionDomainName,
      description: "CloudFront domain name (*.cloudfront.net)",
      exportName: `tripplan-${stage}-distribution-domain`,
    });

    new cdk.CfnOutput(this, "WebUrl", {
      value:
        this.webDomainName !== undefined
          ? `https://${this.webDomainName}`
          : `https://${this.distributionDomainName}`,
      description: "Public web base URL (custom domain when cert configured)",
      exportName: `tripplan-${stage}-web-url`,
    });
  }
}

/**
 * Stage-aware default hostnames. Override with CDK context `webDomain`.
 * Empty string context means "no custom domain".
 */
export function resolveWebDomain(
  stage: Stage,
  override: string | undefined,
): string | undefined {
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return defaultSpaDomain(stage);
}

export function buildContentSecurityPolicy(
  documentsBucketDomainName: string,
): string {
  const docsHost = documentsBucketDomainName.replace(/^https?:\/\//, "");
  // Design §Security: self, MapTiler, docs S3 (us-east-1), auth.ericminassian.com.
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.maptiler.com",
    [
      "connect-src 'self'",
      "https://auth.ericminassian.com",
      "https://*.maptiler.com",
      `https://${docsHost}`,
    ].join(" "),
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Extract hostname from an absolute API URL that may be a CloudFormation token.
 * `https://host` or `https://host/path` → `host` via split on `/` (index 2).
 */
function httpApiHostname(httpApiUrl: string): string {
  // Avoid `new URL()` — CDK tokens are not concrete strings at synth time.
  return cdk.Fn.select(2, cdk.Fn.split("/", httpApiUrl));
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
