import * as cdk from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { isProdStage, type Stage } from "../stage.js";

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** API Lambda from ApiStack (latency + error metrics). */
  readonly apiFunction: lambda.IFunction;
  /** HTTP API from ApiStack (5xx + latency). */
  readonly httpApi: apigwv2.IHttpApi;
  /**
   * Trip-delete DLQ when the delete worker lands (PR15).
   * When omitted, a dashboard text + documented alarm placeholder is used.
   */
  readonly deleteDlq?: sqs.IQueue;
  /**
   * Email for AWS Budgets + alarm SNS subscriptions.
   * **Required for prod** (enforced in bin/app.ts). Optional for other stages.
   * Pass via CDK context: `-c alertEmail=ops@example.com`
   */
  readonly alertEmail?: string;
  /**
   * Absolute base URL for runbook markdown (no trailing slash), e.g.
   * `https://github.com/org/tripplan/blob/main/packages/infra/runbooks`.
   * When set, dashboard text widgets link to `{base}/{file}.md`.
   * When omitted, paths are shown as monospaced repo paths (CloudWatch cannot
   * resolve relative `./runbooks/…` links).
   */
  readonly runbookBaseUrl?: string;
}

/** Custom metric namespace for application-emitted signals (EMF later). */
export const TRIPPLAN_METRIC_NAMESPACE = "TripPlan";

/** Design latency target (dashboard annotation). Alarm threshold is higher — cold starts. */
export const API_P95_DESIGN_TARGET_MS = 1500;
/** Alarm threshold for Lambda p95 Duration (ms). Raised above design target to reduce cold-start noise. */
export const API_P95_ALARM_THRESHOLD_MS = 3000;
/** Min HTTP API Count in a 5m period before 5xx rate% is evaluated. */
export const API_5XX_MIN_REQUESTS = 20;

/** WebACL resource name (CFN / console). Not used as CW dimension. */
const WEB_ACL_NAME = (stage: Stage): string => `tripplan-${stage}-api`;
/** Rule resource names (CFN). Not used as CW Rule dimension. */
const WAF_RATE_RULE_NAME = "RateLimitByIp";
const WAF_MANAGED_COMMON_RULE_NAME = "AWSManagedRulesCommonRuleSet";

/**
 * AWS/WAFV2 CloudWatch dimensions WebACL and Rule must match VisibilityConfig
 * metricName values — not the WebACL/rule resource names.
 * @see https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html
 */
const wafVisibilityMetrics = (stage: Stage) =>
  ({
    webAcl: `tripplan-${stage}-api-waf`,
    rateRule: `tripplan-${stage}-waf-rate`,
    commonRuleSet: `tripplan-${stage}-waf-common`,
  }) as const;

/**
 * Ops plane: CloudWatch dashboard + alarms, AWS Budgets, WAF rate ACL,
 * and dashboard text pointing at runbooks under packages/infra/runbooks/.
 *
 * Depends on ApiStack for Lambda / HTTP API metrics. SQS DLQ is optional until
 * the delete worker exists.
 */
export class ObservabilityStack extends cdk.Stack {
  readonly alarmTopic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { stage, apiFunction, httpApi } = props;
    const prod = isProdStage(stage);
    const webAclName = WEB_ACL_NAME(stage);
    const wafMetrics = wafVisibilityMetrics(stage);

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `tripplan-alarms-${stage}`,
      displayName: `TripPlan ${stage} alarms`,
    });

    if (props.alertEmail !== undefined && props.alertEmail.length > 0) {
      new sns.Subscription(this, "AlarmEmailSubscription", {
        topic: this.alarmTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertEmail,
      });
    }

    const alarmAction = new actions.SnsAction(this.alarmTopic);

    // ── Lambda metrics ──────────────────────────────────────────────────────
    const functionName = apiFunction.functionName;
    const lambdaErrors = apiFunction.metricErrors({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const lambdaInvocations = apiFunction.metricInvocations({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const lambdaDurationP95 = apiFunction.metricDuration({
      period: cdk.Duration.minutes(5),
      statistic: "p95",
    });
    const lambdaThrottles = apiFunction.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });

    // ── API Gateway HTTP API metrics (ApiId + Stage=$default) ───────────────
    // Prefer ApiId+Stage so graphs populate when the account only emits the
    // stage-dimensioned series (common footgun for HTTP APIs).
    const apiId = httpApi.apiId;
    const httpApiDimensions = {
      ApiId: apiId,
      Stage: "$default",
    };
    const api5xx = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5xx",
      dimensionsMap: httpApiDimensions,
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const apiCount = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: httpApiDimensions,
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const apiLatencyP95 = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Latency",
      dimensionsMap: httpApiDimensions,
      period: cdk.Duration.minutes(5),
      statistic: "p95",
    });

    // ── 5xx rate: require min volume so 1/1 error spikes do not page ─────────
    // Rate is 0 when Count < API_5XX_MIN_REQUESTS (treats sparse traffic as OK).
    const errorRateExpression = new cloudwatch.MathExpression({
      expression: `IF(invocations >= ${API_5XX_MIN_REQUESTS}, 100 * errors / invocations, 0)`,
      usingMetrics: {
        errors: api5xx,
        invocations: apiCount,
      },
      period: cdk.Duration.minutes(5),
      label: `API 5xx rate % (when Count≥${API_5XX_MIN_REQUESTS})`,
    });

    const api5xxRateAlarm = new cloudwatch.Alarm(this, "Api5xxRateAlarm", {
      alarmName: `tripplan-${stage}-api-5xx-rate`,
      alarmDescription: `HTTP API 5xx rate > 1% for 10m when Count≥${API_5XX_MIN_REQUESTS} per 5m. See API Lambda logs.`,
      metric: errorRateExpression,
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxRateAlarm.addAlarmAction(alarmAction);
    // OK actions only on prod once thresholds are the paging path (less noise elsewhere).
    if (prod) {
      api5xxRateAlarm.addOkAction(alarmAction);
    }

    // ── p95 latency: alarm at 3s; design 1.5s is a dashboard annotation only ─
    // Whole-function Duration includes cold starts on 256 MB ARM; 1.5s pages
    // chronically on dogfood traffic. Tighten after warm latency is measured
    // (or route-level EMF timers exist).
    const p95LatencyAlarm = new cloudwatch.Alarm(this, "ApiP95LatencyAlarm", {
      alarmName: `tripplan-${stage}-api-p95-latency`,
      alarmDescription: `API Lambda p95 duration > ${API_P95_ALARM_THRESHOLD_MS}ms for 10m (design target ${API_P95_DESIGN_TARGET_MS}ms on dashboard). Cold starts included.`,
      metric: lambdaDurationP95,
      threshold: API_P95_ALARM_THRESHOLD_MS,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    p95LatencyAlarm.addAlarmAction(alarmAction);
    if (prod) {
      p95LatencyAlarm.addOkAction(alarmAction);
    }

    // ── Enrichment $ budget (custom metric; app emits via EMF later) ────────
    // Until enrich routes publish EMF, this alarm stays OK (missing = not breaching).
    const enrichmentCostMetric = new cloudwatch.Metric({
      namespace: TRIPPLAN_METRIC_NAMESPACE,
      metricName: "EnrichmentEstimatedCostUsd",
      dimensionsMap: { Stage: stage },
      period: cdk.Duration.hours(24),
      statistic: "Sum",
    });

    const enrichmentDailyBudgetUsd = prod ? 25 : 5;

    const enrichmentBudgetAlarm = new cloudwatch.Alarm(
      this,
      "EnrichmentBudgetAlarm",
      {
        alarmName: `tripplan-${stage}-enrichment-budget`,
        alarmDescription: `Estimated enrichment spend > $${enrichmentDailyBudgetUsd}/day. Runbook: packages/infra/runbooks/enrichment-budget.md. NOT LIVE until API emits EMF.`,
        metric: enrichmentCostMetric,
        threshold: enrichmentDailyBudgetUsd,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    enrichmentBudgetAlarm.addAlarmAction(alarmAction);

    // ── DLQ depth (optional queue; placeholder when delete worker not wired) ─
    let dlqDepthAlarm: cloudwatch.Alarm | undefined;
    if (props.deleteDlq !== undefined) {
      dlqDepthAlarm = new cloudwatch.Alarm(this, "DeleteDlqDepthAlarm", {
        alarmName: `tripplan-${stage}-delete-dlq-depth`,
        alarmDescription:
          "Trip-delete DLQ has messages. Runbook: packages/infra/runbooks/delete-dlq.md",
        metric: props.deleteDlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      dlqDepthAlarm.addAlarmAction(alarmAction);
    }

    // ── AWS Budgets: prod only, filtered by Project + Stage cost tags ────────
    // Multi-stage account-wide budgets false-alarmed on total account spend.
    // Only prod gets a monthly budget; CostFilters require Cost Allocation Tags
    // `Project` and `Stage` activated in Billing (user-defined).
    let monthlyLimitUsd: number | undefined;
    if (prod) {
      monthlyLimitUsd = 100;
      const budgetNotifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
        props.alertEmail !== undefined && props.alertEmail.length > 0
          ? [
              {
                notification: {
                  notificationType: "ACTUAL",
                  comparisonOperator: "GREATER_THAN",
                  threshold: 80,
                  thresholdType: "PERCENTAGE",
                },
                subscribers: [
                  {
                    subscriptionType: "EMAIL",
                    address: props.alertEmail,
                  },
                ],
              },
              {
                notification: {
                  notificationType: "FORECASTED",
                  comparisonOperator: "GREATER_THAN",
                  threshold: 100,
                  thresholdType: "PERCENTAGE",
                },
                subscribers: [
                  {
                    subscriptionType: "EMAIL",
                    address: props.alertEmail,
                  },
                ],
              },
            ]
          : [];

      new budgets.CfnBudget(this, "MonthlyCostBudget", {
        budget: {
          budgetName: `tripplan-${stage}-monthly-cost`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: monthlyLimitUsd,
            unit: "USD",
          },
          // Format: user:<tagKey>$<tagValue> (user-defined cost allocation tags).
          costFilters: {
            TagKeyValue: [
              "user:Project$TripPlan",
              `user:Stage$${stage}`,
            ],
          },
          costTypes: {
            includeCredit: false,
            includeDiscount: true,
            includeOtherSubscription: true,
            includeRecurring: true,
            includeRefund: false,
            includeSubscription: true,
            includeSupport: true,
            includeTax: true,
            includeUpfront: true,
            useAmortized: false,
            useBlended: false,
          },
        },
        notificationsWithSubscribers:
          budgetNotifications.length > 0 ? budgetNotifications : undefined,
      });
    }

    // ── WAF WebACL (REGIONAL) ───────────────────────────────────────────────
    // App-layer share (20/h/IP) and enrich (60/h/user) limits remain primary.
    // WAF rate rule is a coarse DoS/scrape backstop only (2000/5m >> app caps).
    // AWS Managed Common Rule Set runs in COUNT first (observe before block).
    this.webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      name: webAclName,
      description:
        "TripPlan HTTP API edge controls. App token-buckets are primary for share/enrich; WAF is coarse DoS + managed rules (count).",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: wafMetrics.webAcl,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: WAF_MANAGED_COMMON_RULE_NAME,
          priority: 0,
          // Count mode: surface AWSCRS matches without blocking until reviewed.
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: wafMetrics.commonRuleSet,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: WAF_RATE_RULE_NAME,
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              // 2000 requests / 5 minutes / IP — not a substitute for app rate limits.
              limit: 2000,
              aggregateKeyType: "IP",
              evaluationWindowSec: 300,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: wafMetrics.rateRule,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate with HTTP API default stage.
    // ARN: arn:aws:apigateway:region::/apis/api-id/stages/$default
    const httpApiStageArn = cdk.Stack.of(this).formatArn({
      service: "apigateway",
      account: "",
      resource: `/apis/${apiId}/stages/$default`,
    });

    new wafv2.CfnWebACLAssociation(this, "HttpApiWebAclAssociation", {
      resourceArn: httpApiStageArn,
      webAclArn: this.webAcl.attrArn,
    });

    // WAFV2 metrics (REGIONAL): WebACL + Rule dimensions = VisibilityConfig metricNames
    const wafRegion = cdk.Stack.of(this).region;
    const wafBlockedAll = new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        WebACL: wafMetrics.webAcl,
        Region: wafRegion,
        Rule: "ALL",
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const wafAllowedAll = new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "AllowedRequests",
      dimensionsMap: {
        WebACL: wafMetrics.webAcl,
        Region: wafRegion,
        Rule: "ALL",
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const wafBlockedRateRule = new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        WebACL: wafMetrics.webAcl,
        Region: wafRegion,
        Rule: wafMetrics.rateRule,
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const wafCountedCommon = new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "CountedRequests",
      dimensionsMap: {
        WebACL: wafMetrics.webAcl,
        Region: wafRegion,
        Rule: wafMetrics.commonRuleSet,
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });

    // ── Dashboard ───────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, "OpsDashboard", {
      dashboardName: `TripPlan-${stage}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    const runbookLines = formatRunbookTable(props.runbookBaseUrl);

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 4,
        markdown: [
          `# TripPlan ops — \`${stage}\``,
          "",
          "**Runbooks** (source of truth: `packages/infra/runbooks/` in the monorepo):",
          "",
          ...runbookLines,
          "",
          `Lambda: \`${functionName}\` · API id: \`${apiId}\` · WAF: \`${webAclName}\``,
          "",
          prod
            ? "**Prod:** DynamoDB PITR is enabled in DataStack — verify via delete-dlq runbook. Monthly AWS Budget is TripPlan+Stage-tagged ($100)."
            : `**Non-prod:** PITR off; **no** AWS monthly budget (prod-only).`,
        ].join("\n"),
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 3,
        markdown: [
          "### Metric readiness (do not assume empty panels mean zero risk)",
          "",
          `- **Enrichment $:** \`TripPlan/EnrichmentEstimatedCostUsd\` is **not emitted** until enrich routes ship EMF. Alarm stays OK while missing. Follow-up: emit estimated USD per enrich attempt (namespace \`${TRIPPLAN_METRIC_NAMESPACE}\`, dimension \`Stage\`).`,
          "- **Delete DLQ:** real metric only when `deleteDlq` is wired (delete worker PR).",
          "- **Future EMF (design table, not alarmed yet):** enrichment outcome ratios (fail > 20%), share 401/403/410 counters, upload presign→confirm rate, trips/week.",
          "- **WAF vs app limits:** app share 20 attempts/h/IP and enrich 60/h/user are primary; WAF 2000/5m is coarse DoS only. Common Rule Set is **COUNT** (review before block).",
        ].join("\n"),
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API Lambda — Duration (p50 / p95 / max)",
        width: 12,
        height: 6,
        left: [
          apiFunction.metricDuration({
            period: cdk.Duration.minutes(5),
            statistic: "p50",
            label: "p50",
          }),
          lambdaDurationP95.with({ label: "p95" }),
          apiFunction.metricDuration({
            period: cdk.Duration.minutes(5),
            statistic: "Maximum",
            label: "max",
          }),
        ],
        leftYAxis: { label: "ms", min: 0 },
        leftAnnotations: [
          {
            value: API_P95_DESIGN_TARGET_MS,
            label: `design p95 ${API_P95_DESIGN_TARGET_MS}ms`,
            color: cloudwatch.Color.ORANGE,
          },
          {
            value: API_P95_ALARM_THRESHOLD_MS,
            label: `alarm ${API_P95_ALARM_THRESHOLD_MS}ms`,
            color: cloudwatch.Color.RED,
          },
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "API Lambda — Invocations / Errors / Throttles",
        width: 12,
        height: 6,
        left: [
          lambdaInvocations.with({ label: "invocations" }),
          lambdaErrors.with({ label: "errors" }),
          lambdaThrottles.with({ label: "throttles" }),
        ],
        leftYAxis: { label: "count", min: 0 },
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "HTTP API — Count / 5xx (ApiId + Stage=$default)",
        width: 12,
        height: 6,
        left: [
          apiCount.with({ label: "Count" }),
          api5xx.with({ label: "5xx" }),
        ],
        leftYAxis: { label: "count", min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: "HTTP API — Latency p95",
        width: 12,
        height: 6,
        left: [apiLatencyP95.with({ label: "p95 Latency" })],
        leftYAxis: { label: "ms", min: 0 },
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "WAF — Allowed / Blocked (ALL) + rate rule blocks",
        width: 12,
        height: 6,
        left: [
          wafAllowedAll.with({ label: "Allowed (ALL)" }),
          wafBlockedAll.with({ label: "Blocked (ALL)" }),
          wafBlockedRateRule.with({
            label: `Blocked (${wafMetrics.rateRule})`,
          }),
        ],
        leftYAxis: { label: "requests", min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: "WAF — Managed Common Rule Set (COUNT mode)",
        width: 12,
        height: 6,
        left: [
          wafCountedCommon.with({
            label: `Counted (${wafMetrics.commonRuleSet})`,
          }),
        ],
        leftYAxis: { label: "requests", min: 0 },
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title:
          "Enrichment estimated cost (USD / 24h) — empty until EMF ships",
        width: 12,
        height: 6,
        left: [
          enrichmentCostMetric.with({ label: "EnrichmentEstimatedCostUsd" }),
        ],
        leftYAxis: { label: "USD", min: 0 },
        leftAnnotations: [
          {
            value: enrichmentDailyBudgetUsd,
            label: `daily budget $${enrichmentDailyBudgetUsd}`,
            color: cloudwatch.Color.RED,
          },
        ],
      }),
      new cloudwatch.GraphWidget({
        title: props.deleteDlq
          ? "Delete DLQ — ApproximateNumberOfMessagesVisible"
          : "Delete DLQ — not provisioned yet (placeholder)",
        width: 12,
        height: 6,
        left: props.deleteDlq
          ? [
              props.deleteDlq.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(5),
                statistic: "Maximum",
                label: "DLQ depth",
              }),
            ]
          : [
              new cloudwatch.Metric({
                namespace: TRIPPLAN_METRIC_NAMESPACE,
                metricName: "DeleteDlqDepthPlaceholder",
                dimensionsMap: { Stage: stage },
                period: cdk.Duration.minutes(5),
                statistic: "Maximum",
                label: "DLQ not wired (always empty)",
              }),
            ],
        leftYAxis: { label: "messages", min: 0 },
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: "Alarms",
        width: 24,
        height: 3,
        alarms: [
          api5xxRateAlarm,
          p95LatencyAlarm,
          enrichmentBudgetAlarm,
          ...(dlqDepthAlarm !== undefined ? [dlqDepthAlarm] : []),
        ],
      }),
    );

    if (props.deleteDlq === undefined) {
      this.dashboard.addWidgets(
        new cloudwatch.TextWidget({
          width: 24,
          height: 2,
          markdown: [
            "### Delete DLQ note",
            "Trip-delete SQS + DLQ are **not** in this stack yet (delete worker PR).",
            "When the queue exists, pass `deleteDlq` into `ObservabilityStack` to replace the placeholder metric and enable `tripplan-{stage}-delete-dlq-depth`.",
            "Until then follow `packages/infra/runbooks/delete-dlq.md` for manual recovery steps.",
          ].join("\n\n"),
        }),
      );
    }

    // ── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "DashboardName", {
      value: this.dashboard.dashboardName,
      description: "CloudWatch dashboard name",
      exportName: `tripplan-${stage}-dashboard-name`,
    });

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic for TripPlan alarms",
      exportName: `tripplan-${stage}-alarm-topic-arn`,
    });

    new cdk.CfnOutput(this, "WebAclArn", {
      value: this.webAcl.attrArn,
      description:
        "WAFv2 WebACL ARN (REGIONAL; associated with HTTP API $default)",
      exportName: `tripplan-${stage}-web-acl-arn`,
    });

    if (monthlyLimitUsd !== undefined) {
      new cdk.CfnOutput(this, "MonthlyBudgetUsd", {
        value: String(monthlyLimitUsd),
        description:
          "AWS Budgets monthly cost limit (USD); prod only; TagKeyValue Project+Stage",
        exportName: `tripplan-${stage}-monthly-budget-usd`,
      });
    }
  }
}

function formatRunbookTable(runbookBaseUrl: string | undefined): string[] {
  const entries: ReadonlyArray<{ incident: string; file: string }> = [
    { incident: "Share abuse / 401 spike", file: "share-abuse.md" },
    { incident: "Enrichment $ budget", file: "enrichment-budget.md" },
    { incident: "Delete DLQ", file: "delete-dlq.md" },
  ];

  const header = [
    "| Incident | Runbook |",
    "|----------|---------|",
  ];

  if (runbookBaseUrl !== undefined && runbookBaseUrl.length > 0) {
    const base = runbookBaseUrl.replace(/\/$/, "");
    return [
      ...header,
      ...entries.map(
        (e) =>
          `| ${e.incident} | [${e.file}](${base}/${e.file}) |`,
      ),
    ];
  }

  // CloudWatch cannot resolve repo-relative links — plain monospaced paths only.
  return [
    ...header,
    ...entries.map(
      (e) =>
        `| ${e.incident} | \`packages/infra/runbooks/${e.file}\` |`,
    ),
  ];
}
