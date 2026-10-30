# Serverless extension validation

Executed in the isolated cloud workspace on October 30, 2026. These are
AI-assisted checks, not claims of independent user verification or a live AWS
deployment. Baseline commit: `9525435d37cac714b10764546d5ff554eaf2b173`.

## Commands and observed outcomes

All npm commands ran from `/workspace/commerce-integration-core`.

| Command/check | Observed result |
| --- | --- |
| Baseline `npm run typecheck`, `npm test`, `npm run build` | Passed; original 24 tests passed, none failed/skipped |
| `npm ci --cache /tmp/commerce-npm-cache --strict-ssl=true` | Passed from the updated lockfile; 151 packages installed |
| `npm run typecheck` | Passed, including Lambda, tests, and local helper |
| `npm test` | 93 passed, 0 failed, 0 skipped; original 24 plus 69 serverless tests, including nested secret-provider cases |
| `npm run build` | Passed; original TypeScript build remains unchanged |
| `npm run build:serverless` | Passed; emitted bundled `serverless-dist/index.mjs` (about 1.4 MiB) |
| `DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run test:serverless:integration` | 10 passed, 0 failed/skipped; real local conditional expressions and signed request persistence |
| `DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run serverless:local` | First acceptance, duplicate acknowledgement, stored event equality verified; temporary table removed |
| `sam validate --lint` | Passed with AWS SAM CLI 1.171.0 |
| `sam build` | Passed using custom Makefile; function artifact contained only `index.mjs` |
| Bundle smoke test under Node 24 | Imported bundle, authenticated a signed fixture through injected dependencies, verified persistence boundary, and checked missing configuration returns 503 |
| Bundle import under official `node:22-alpine` with `--network none` | Passed; handler exports and missing-configuration 503 verified under the deployed runtime major |
| `npm run worker:inventory` | Passed against PostgreSQL; suppliers intentionally disabled, zero supplier records processed |
| `npm run worker:sla` | Passed against PostgreSQL; local database has no live orders |
| Existing `npm run dev` and HTTP probes | Health 200 with expected service JSON; unsigned Shopify webhook 401 `invalid_signature` |
| PostgreSQL readiness/schema | Ready; all 11 public tables present, existing data/volume preserved |
| `git diff --check` and artifact review | Passed; `.env`, bundles, SAM output, credentials, and dependency caches excluded from source control |

The integration runner includes its parent test and endpoint guard in the count
of ten. It uses the official DynamoDB Local image, pinned in CI to
`sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86`.
It creates disposable tables with dummy credentials and refuses non-loopback
endpoints. The Node 22 image used for the import smoke check resolved to
`sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`.

The cloud home directory is read-only. npm's initial default-cache installation
failed; selecting `/tmp/commerce-npm-cache` fixed it while retaining integrity
and TLS verification. SAM initially reported metadata-write warnings despite
successful validation. The following invocation removed those warnings and
successfully validated and packaged without AWS account access:

```bash
SAM_CLI_TELEMETRY=0 \
__SAM_CLI_APP_DIR=/tmp/commerce-sam-config \
AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=us-east-1 \
  /tmp/commerce-sam-venv/bin/sam validate --lint

SAM_CLI_TELEMETRY=0 \
__SAM_CLI_APP_DIR=/tmp/commerce-sam-config \
AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=us-east-1 \
  /tmp/commerce-sam-venv/bin/sam build
```

The CLI was installed in a task-local virtual environment with
`python3 -m venv /tmp/commerce-sam-venv` and
`/tmp/commerce-sam-venv/bin/pip install --cache-dir /tmp/commerce-pip-cache aws-sam-cli`.
The resolved version was 1.171.0; CI pins that version. These temporary tool paths
are not required on a developer machine with SAM already installed.

## Review and limitations

Code review covered exact-byte authentication, strict payload boundaries,
conditional-write races, stale-owner fencing, lost acknowledgements, secret
caching, sanitized errors/logs, artifact contents, and scoped runtime IAM.
SDK attempts have 500 ms connection and 1500 ms request timeouts, with at most
two attempts. Cumulative operations or a hard Lambda deadline can still yield
platform-generated 5xx responses; sender retries and lease expiry remain needed.

Unit tests inject service failures; local integration validates DynamoDB command
semantics. Neither proves live IAM authorization, Secrets Manager access,
CloudWatch delivery, API Gateway transport behavior, TTL removal, or availability
under production load. Those checks, `sam local invoke` with the production
entry point, and live deployment were not performed. The updated GitHub Actions
workflow was prepared but has not been observed running remotely.

No AWS account connection, paid resource creation, account changes, deployment,
teardown, main-branch push, merge, or environment configuration publication was
performed. Deployment remains **PENDING USER APPROVAL**.

The external environment setup script was reviewed without modification. It
preserves `.env` and database volumes and keeps TLS verification, but its schema
guard checks only `suppliers` and cannot diagnose/repair a partial schema. The
existing supplier boolean and `npm start` path defects remain unchanged. See the
[serverless guide](SERVERLESS.md) for replay, retry, retention, cost, and rotation
limitations.
