# AWS deployment and evidence runbook

Status: **NOT DEPLOYED / PENDING USER APPROVAL**. Prepared November 1, 2026
(America/Denver). No live results, screenshots, account permissions, or costs
have been observed. Local results are in [VALIDATION.md](VALIDATION.md).

## Prerequisites and approval boundary

Approve the sandbox account ID, region, stack name (at most 56 characters),
existing signing-secret ARN, IAM changes, public endpoint exposure, cost budget,
and retention/cleanup plan before creating resources. Use AWS CLI v2, SAM CLI
1.171.0, Node.js 22+, npm, Make, and a least-privilege deployment identity.
The deployment identity needs CloudFormation/SAM artifact upload and resource
provisioning permissions, including IAM role creation and PassRole; the Lambda
runtime role is narrower. Review your organization's permission policy rather
than attaching administrator access. Check Lambda regional concurrency quota:
reserving five executions must leave AWS's required unreserved capacity.

In the AWS Console, select the approved region. In Billing, review a budget and
notification threshold (a budget is not a spending cap). In Secrets Manager,
use an existing dedicated secret or obtain separate approval to create one:
Other type of secret → Plaintext, a cryptographically random raw text key of
32–4096 bytes (at least 32 characters), encrypted with the AWS managed key.
Store no JSON wrapper, newline, or binary value. Never capture its value in a
screenshot or Git. The supplied template does not grant customer-managed KMS
key access. Ensure secret and stack are in the approved account/region.

## Manual deployment after approval

Run from the repository root. Set non-secret selectors to approved values:

```bash
export AWS_PROFILE='<approved-profile>'
export AWS_REGION='<approved-region>'
export STACK_NAME='commerce-webhook-dev'
export SECRET_ARN='<existing-secret-arn>'
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
git branch --show-current
git rev-parse HEAD
npm ci
npm run typecheck
npm test
npm run build
npm run build:serverless
npm run validate:serverless
```

Confirm the identity/account and reviewed source commit. Local SAM validation
uses disposable dummy configuration; deployment below uses your selected real
profile. Do not use the local wrapper for deployment.

```bash
sam deploy --guided --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --parameter-overrides WebhookSecretArn="$SECRET_ARN"
```

Choose changeset confirmation, retain rollback, and acknowledge scoped IAM role
creation (`CAPABILITY_IAM`). Review each proposed resource before executing the
changeset. SAM artifact bucket creation also requires approval. Do not save
account-specific config to tracked `samconfig.toml`; use ignored
`samconfig.local.toml` if needed. Wait for CREATE_COMPLETE/UPDATE_COMPLETE; on
failure, inspect CloudFormation events and rollback status before retrying.

```bash
aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}'
```

Copy the WebhookUrl output into `WEBHOOK_URL`; record table/log outputs below.
In Lambda → Configuration → Permissions, inspect the execution policy. In API
Gateway → Routes, verify POST /webhooks/orders and payload format 2.0. Inspect
Lambda's resource policy for the SAM-generated API Gateway invoke permission,
scoped to this API's POST route. Do not confuse it with the execution role.

## Synthetic endpoint demonstration

Run only after deployment approval. The script performs five real requests,
creates one synthetic completed notification, and may incur service charges.
It accepts only the standard stack HTTPS execute-api URL and refuses redirects
and query strings. Custom domains are deliberately unsupported.

Load the raw-text key into this process environment without echoing it, passing
it on the command line, saving it to disk, or enabling shell tracing:

```bash
export WEBHOOK_URL='<WebhookUrl-output>'
set +x
WEBHOOK_DEMO_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" --query SecretString --output text) || exit 1
export WEBHOOK_DEMO_SECRET
npm run serverless:demo
unset WEBHOOK_DEMO_SECRET
```

The caller needs GetSecretValue on this dedicated secret. Use a trusted isolated
terminal; do not dump its environment. The helper deletes its inherited key
variable, retains synthetic bytes in memory for the retry, and prints only case,
HTTP status, pass/fail, and a synthetic event ID. The shell unsets its own copy.
No response bodies, signatures, keys, or payloads are printed/persisted. Each
new process uses new UUIDs. It stops on an unexpected result; investigate an
uncertain acceptance with the event ID before starting again. It does not
silently retry 503s. A rerun starts a new demonstration, not a retry of the old
process. Do not use real customer data.

| Case | Expected | Actual live result | Evidence |
| --- | --- | --- | --- |
| Valid notification | 200, ok=true, duplicate=false | NOT RUN | Pending |
| Same bytes and ID | 200, ok=true, duplicate=true | NOT RUN | Pending |
| Incorrect HMAC | 401, invalid_signature | NOT RUN | Pending |
| Same ID, changed signed bytes | 409, event_conflict | NOT RUN | Pending |
| Signed invalid schema | 400, invalid_request | NOT RUN | Pending |

## Verify persistence and logs separately

The demo's HTTP checks do not prove direct database/log access. Use the printed
synthetic ID and the stack's table output with a read-only identity:

```bash
export TABLE_NAME='<WebhookTableName-output>'
export EVENT_ID='<synthetic-event-id-from-demo>'
aws dynamodb get-item --table-name "$TABLE_NAME" --consistent-read \
  --key "{\"id\":{\"S\":\"$EVENT_ID\"}}" \
  --projection-expression 'id, #s, payloadHash, updatedAt, expiresAt' \
  --expression-attribute-names '{"#s":"status"}'
```

Expected: status COMPLETED, payloadHash present, expiresAt approximately seven
days after completion. In DynamoDB Console → Explore table items, verify only
the synthetic event is stored with the original synthetic order ID after the
409 attempt. Check owner/leaseUntil are absent. Avoid exporting real payloads.
TTL is asynchronous; this test does not establish actual expiry/deletion.

In CloudWatch → Log groups, select WebhookLogGroupName. Logs Insights:

```text
fields @timestamp, requestId, gatewayRequestId, eventId, stage, message
| filter eventId = '<synthetic-event-id>'
| sort @timestamp asc
```

Lambda JSON wrapping can place fields inside the message object; inspect a
record and parse that object if fields are not discovered. Expect acceptance,
duplicate and conflict records; use gatewayRequestId to correlate access logs
in HttpApiLogGroupName. Invalid schema can return without an application log;
verify access-log status 400. Verify no bodies, signatures, keys, or raw SDK
errors appear. Allow normal delivery delay. Inspect error/throttle metrics;
these five requests do not prove load capacity or an availability SLA.

## Resource inventory and observed evidence

| Resource | Owner/lifecycle | Actual identifier/status |
| --- | --- | --- |
| HTTP API, default stage, POST route/integration | Stack; delete with stack | Pending |
| Lambda nodejs22.x, 256 MiB, 10 s, concurrency 5 | Stack | Pending |
| Lambda invoke permission | SAM generated; scoped to API/route | Pending |
| IAM execution role/policy | Stack; GetItem/UpdateItem, specific secret and logs | Pending |
| DynamoDB on-demand, encryption, PITR, TTL | Retained on deletion/replacement | Pending |
| Lambda and API access log groups | Stack; 14-day retention | Pending |
| Signing secret | Pre-existing; stack does not delete it | Pending |
| SAM S3 artifacts/bucket | Deployment tooling; inspect separately | Pending |

Capture sanitized screenshots/output for: reviewed commit and green CI;
CloudFormation completed stack and outputs; resource inventory/changeset; scoped
execution role and invocation permission; five passing demo results; completed
synthetic DynamoDB row; correlated CloudWatch records; budget settings; and
post-cleanup inventory. Redact account IDs/ARNs where appropriate. Never show
Secrets Manager's Retrieve secret value panel, environment dumps, signed
headers, personal data, or console command history containing keys.

Record deployment timestamp/timezone, commit SHA, CLI/runtime versions, selected
region, operator, expected/actual outcomes and evidence filenames. All remain
**PENDING** until observed. Failed checks belong in the record with diagnosis,
fix, and rerun evidence; do not replace them with expected values.

## Teardown after separate explicit approval

Export required sanitized evidence first; stack deletion removes log groups.
Record the retained table and any replacement tables before deleting the stack.
After approval for stack deletion:

```bash
sam delete --stack-name "$STACK_NAME" --region "$AWS_REGION" --profile "$AWS_PROFILE"
```

Review prompts and artifact deletions. The DynamoDB table is retained and can
continue charging for storage/PITR. Only after separately approving data loss:

```bash
aws dynamodb delete-table --table-name "$TABLE_NAME"
aws dynamodb wait table-not-exists --table-name "$TABLE_NAME"
```

Review pre-existing secret consumers before scheduling its deletion (separate
approval, normal recovery window). Inspect SAM artifact buckets for this stack's
objects; do not empty shared buckets. Confirm API/Lambda/role/log deletion,
retained/replacement tables, secret disposition, and storage/backup/artifact
charges in the final inventory. Billing data can lag; budget alerts are not
proof that all resources were removed.

## Conditions before merge

- Reviewed feature commit, clean diff, green CI with no skipped integration checks.
- Focused review of authentication, fencing, IAM, packaging and safe logs.
- Approved sandbox deployment and all five endpoint cases observed.
- DynamoDB and CloudWatch evidence captured; AWS-only defects resolved.
- Limitations and portfolio claims match observations; cost/cleanup plan recorded.
- User explicitly approves merge. Deployment approval alone does not approve merge.
