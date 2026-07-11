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
  /** HTTP API from ApiStack (5xx + latency placeholders). */
  readonly httpApi: apigwv2.IHttpApi;
  /**
   * Trip-delete DLQ when the delete worker lands (PR15).
   * When omitted, a dashboard text + documented alarm placeholder is used.
   */
  readonly deleteDlq?: sqs.IQueue;
  /**
   * Optional email for AWS Budgets + alarm SNS subscriptions.
   * Pass via CDK context: `-c alertEmail=ops@example.com`
   */
  readonly alertEmail?: string;
}

/** Custom metric namespace for application-emitted signals (EMF later). */
export const TRIPPLAN_METRIC_NAMESPACE = "TripPlan";

/**
 * Ops plane: CloudWatch dashboard + alarms, AWS Budgets, WAF rate ACL,
 * and dashboard text widgets that point at runbooks under packages/infra/runbooks/.
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

    // ── API Gateway HTTP API metrics (placeholders by ApiId) ────────────────
    // HTTP API metrics use dimension ApiId (not ApiName). Stage is $default.
    const apiId = httpApi.apiId;
    const api5xx = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5xx",
      dimensionsMap: { ApiId: apiId },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const apiCount = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: { ApiId: apiId },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const apiLatencyP95 = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Latency",
      dimensionsMap: { ApiId: apiId },
      period: cdk.Duration.minutes(5),
      statistic: "p95",
    });

    // ── 5xx rate alarm (API Gateway 5xx / Count via metric math) ─────────────
    const errorRateAlarm = new cloudwatch.MathExpression({
      expression: "IF(invocations > 0, 100 * errors / invocations, 0)",
      usingMetrics: {
        errors: api5xx,
        invocations: apiCount,
      },
      period: cdk.Duration.minutes(5),
      label: "API 5xx rate (%)",
    });

    const api5xxRateAlarm = new cloudwatch.Alarm(this, "Api5xxRateAlarm", {
      alarmName: `tripplan-${stage}-api-5xx-rate`,
      alarmDescription:
        "HTTP API 5xx rate > 1% over 10 minutes (2×5m). See API Lambda logs.",
      metric: errorRateAlarm,
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxRateAlarm.addAlarmAction(alarmAction);
    api5xxRateAlarm.addOkAction(alarmAction);

    // ── p95 latency (Lambda Duration; APIGW Latency also on dashboard) ──────
    const p95LatencyAlarm = new cloudwatch.Alarm(this, "ApiP95LatencyAlarm", {
      alarmName: `tripplan-${stage}-api-p95-latency`,
      alarmDescription:
        "API Lambda p95 duration > 1.5s for 10 minutes. Design target for typical trip routes.",
      metric: lambdaDurationP95,
      threshold: 1500,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    p95LatencyAlarm.addAlarmAction(alarmAction);
    p95LatencyAlarm.addOkAction(alarmAction);

    // ── Enrichment $ budget (custom metric; app emits via EMF later) ────────
    // Until enrich routes publish EMF, this alarm stays OK (missing = not breaching).
    const enrichmentCostMetric = new cloudwatch.Metric({
      namespace: TRIPPLAN_METRIC_NAMESPACE,
      metricName: "EnrichmentEstimatedCostUsd",
      dimensionsMap: { Stage: stage },
      period: cdk.Duration.hours(24),
      statistic: "Sum",
    });

    // Daily USD soft cap — tighten after vendor review (see enrichment-budget runbook).
    const enrichmentDailyBudgetUsd = prod ? 25 : 5;

    const enrichmentBudgetAlarm = new cloudwatch.Alarm(
      this,
      "EnrichmentBudgetAlarm",
      {
        alarmName: `tripplan-${stage}-enrichment-budget`,
        alarmDescription: `Estimated enrichment spend > $${enrichmentDailyBudgetUsd}/day. Runbook: packages/infra/runbooks/enrichment-budget.md`,
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

    // ── AWS Budgets (monthly account-scoped cost for this stage tag filter) ─
    // Budgets API is account-level; we name by stage and optionally notify email.
    const monthlyLimitUsd = prod ? 100 : stage === "staging" ? 40 : 25;
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
        // Cost filters by tag require Cost Allocation Tags activated in billing.
        // Until then the budget is account-wide named for this stage — ops should
        // enable the Project/Stage tags and switch to CostFilters if needed.
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

    // ── WAF WebACL (REGIONAL) — rate-based rule for later CF/API attach ──────
    // Scope REGIONAL so it can associate to API Gateway HTTP API stages.
    // CloudFront needs CLOUDFRONT + us-east-1; WebStack can add a CF-scoped ACL later.
    this.webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      name: `tripplan-${stage}-api`,
      description:
        "TripPlan rate-based protection for HTTP API (share abuse / scraping). Associate with API stage or CloudFront.",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `tripplan-${stage}-api-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimitByIp",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              // 2000 requests / 5 minutes / IP — tighten via share-abuse runbook.
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `tripplan-${stage}-waf-rate`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate with HTTP API default stage when we have a concrete API id.
    // ARN format: arn:aws:apigateway:region::/apis/api-id/stages/$default
    const httpApiStageArn = cdk.Stack.of(this).formatArn({
      service: "apigateway",
      account: "",
      resource: `/apis/${apiId}/stages/$default`,
    });

    new wafv2.CfnWebACLAssociation(this, "HttpApiWebAclAssociation", {
      resourceArn: httpApiStageArn,
      webAclArn: this.webAcl.attrArn,
    });

    // ── Dashboard ───────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, "OpsDashboard", {
      dashboardName: `TripPlan-${stage}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 3,
        markdown: [
          `# TripPlan ops — \`${stage}\``,
          "",
          "**Runbooks** (repo paths under `packages/infra/runbooks/`):",
          "",
          "| Incident | Runbook |",
          "|----------|---------|",
          "| Share abuse / 401 spike | [`share-abuse.md`](./runbooks/share-abuse.md) |",
          "| Enrichment $ budget | [`enrichment-budget.md`](./runbooks/enrichment-budget.md) |",
          "| Delete DLQ | [`delete-dlq.md`](./runbooks/delete-dlq.md) |",
          "",
          `Lambda: \`${functionName}\` · API id: \`${apiId}\` · WAF: \`${this.webAcl.name ?? `tripplan-${stage}-api`}\``,
          "",
          prod
            ? "**Prod:** DynamoDB PITR is enabled in DataStack — verify with the delete-dlq / recovery section of the runbooks."
            : `**Non-prod:** PITR is off for \`${stage}\` (enabled only on prod).`,
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
        title: "HTTP API — Count / 5xx",
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
        title: "Enrichment estimated cost (USD / 24h sum)",
        width: 12,
        height: 6,
        left: [enrichmentCostMetric.with({ label: "EnrichmentEstimatedCostUsd" })],
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
              // Placeholder metric so the panel exists before SQS delete worker (PR15).
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
            "Until then follow [`delete-dlq.md`](./runbooks/delete-dlq.md) for manual recovery steps.",
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
      description: "WAFv2 WebACL ARN (REGIONAL; associated with HTTP API $default)",
      exportName: `tripplan-${stage}-web-acl-arn`,
    });

    new cdk.CfnOutput(this, "MonthlyBudgetUsd", {
      value: String(monthlyLimitUsd),
      description: "AWS Budgets monthly cost limit (USD) for this stage name",
      exportName: `tripplan-${stage}-monthly-budget-usd`,
    });
  }
}
