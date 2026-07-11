# Runbook: Trip-delete DLQ

**Signals:** CloudWatch alarm `tripplan-{stage}-delete-dlq-depth` (when SQS DLQ is wired); queue age; failed delete worker logs; trips stuck in `deleting`.

**Dashboard:** CloudWatch → `TripPlan-{stage}` → “Delete DLQ” panel

## Status of infrastructure

| Component | Status |
|-----------|--------|
| Trip-delete SQS + DLQ | **Not provisioned yet** (delete worker PR). ObservabilityStack shows a **placeholder** metric until `deleteDlq` is passed in. |
| Alarm `tripplan-{stage}-delete-dlq-depth` | Created only when `deleteDlq` is provided to ObservabilityStack |
| DynamoDB table | `TripPlan-{stage}` in DataStack |

Until the queue exists, treat stuck deletes as **manual data-plane recovery** (below).

## Goals

Drain the DLQ safely after fixing root cause; leave no orphan S3 objects or share sessions for deleted trips.

## Immediate actions (when DLQ exists)

1. **Inspect messages**
   - Read DLQ body: `tripId`, `ownerId`, attempt count, last error.
   - Common causes: IAM missing S3/DDB permissions; S3 prefix list failure; throttle; code bug on session purge (GSI3).

2. **Fix root cause before redrive**
   - IAM: worker role needs DDB R/W on table + GSIs used for session purge, S3 list/delete on `trips/{tripId}/`.
   - Confirm object key layout: `trips/{tripId}/items/{itemId}/{attachmentId}` (no `pending/` prefix).
   - Do **not** redrive while the handler still fails.

3. **Redrive**
   - SQS console → DLQ → start DLQ redrive to main delete queue, **or**
   - `aws sqs start-message-move-task` (source = DLQ, destination = main queue).
   - Watch worker logs and DLQ depth returning to 0.

4. **Manual prefix purge (if redrive cannot complete S3 cleanup)**
   ```bash
   # List then delete under the trip prefix (us-east-1)
   aws s3 ls "s3://${DOCS_BUCKET}/trips/${TRIP_ID}/" --recursive --region us-east-1
   aws s3 rm "s3://${DOCS_BUCKET}/trips/${TRIP_ID}/" --recursive --region us-east-1
   ```
   - Then re-run session purge (GSI3 query `TRIP#tripId` sessions) and set trip meta to terminal deleted state per product rules.

5. **Poison messages**
   - After N failures, export message to ticket, delete from DLQ, fix code, optional one-off re-enqueue.

## DynamoDB PITR (prod recovery)

**PITR is enabled on prod only** in DataStack (`pointInTimeRecoveryEnabled: prod`).

| Stage | PITR | Table deletion protection | Removal policy |
|-------|------|---------------------------|----------------|
| `dev` / `staging` | off | off | DESTROY |
| `prod` | **on** | **on** | RETAIN |

### Verify PITR on prod

```bash
aws dynamodb describe-continuous-backups \
  --region us-east-1 \
  --table-name TripPlan-prod \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'
```

Expect `PointInTimeRecoveryStatus` = `ENABLED`.

### Restore (last resort — coordinate with owners)

1. Restore to a **new** table name via console or `restore-table-to-point-in-time` (does not overwrite live table).
2. Diff affected `TRIP#…` keys; copy only what is required.
3. Do not disable PITR on prod to “save cost” without an explicit durability decision.
4. Stack termination protection is **on** for prod stacks — accidental CFN delete is blocked.

Non-prod tables have **no** PITR; treat data as disposable.

## Verify recovery

- DLQ depth = 0 (or placeholder remains empty pre-worker).
- No trips left in `deleting` beyond the worker SLA.
- S3 prefix for deleted trips is empty; share sessions for those trips gone (GSI3/GSI4).

## Follow-ups

- When delete worker lands: pass the DLQ `IQueue` into `ObservabilityStack` (`deleteDlq`) so the real metric + alarm replace the placeholder.
- Add queue age alarm (ApproximateAgeOfOldestMessage) if deletes must meet a freshness SLO.
