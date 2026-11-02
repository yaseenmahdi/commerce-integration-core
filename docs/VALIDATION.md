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

## Completion validation — November 1, 2026 (America/Denver)

Executed by the AI in the resumed managed Linux cloud environment at
`/workspace/commerce-integration-core` (host clock November 2 UTC). Started from
feature head `cfc0906b3ac20ed6fb4ca0846294bef7c62cc40e`; PR #1 confirmed open and
unmerged. Initial local checkout was baseline `9525435` on `work`; fetched and
switched to the existing remote feature branch without recreating source.

| Check | Observed result |
| --- | --- |
| `npm ci --cache /tmp/commerce-npm-cache --strict-ssl=true` | Passed; 151 packages; unchanged lockfile |
| `npm run typecheck` | Passed, including demonstration script/tests |
| `npm test` | 97 passed, 0 failed/cancelled/skipped; preserved 94 plus 3 demo tests |
| `npm run build` | Passed |
| `npm run build:serverless` | Passed; ~1.4 MiB bundle |
| `DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run test:serverless:integration` | 10 passed, 0 failed/cancelled/skipped |
| `DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run serverless:local` | Acceptance, duplicate and persisted event equality passed; temporary table removed |
| `PATH=/tmp/commerce-sam-venv/bin:$PATH AWS_PROFILE=deliberately-missing npm run validate:serverless` | SAM lint and Makefile build passed, independent of inherited missing profile |
| Import `.aws-sam/build/WebhookFunction/index.mjs` under Node 24 | Passed; missing configuration safely returned 503 |
| SAM artifact inventory | Exactly `index.mjs`; no config, credentials or source copied into function artifact |

Environment versions: Node 24.19.0, npm 11.9.0, SAM CLI 1.171.0 (temporary Python
venv), Docker 28.4.0. DynamoDB Local used the same digest pinned above, a disposable
in-memory container bound to 127.0.0.1:8000, and explicit dummy local credentials.
No AWS resources were used for these checks. The new demo suite invokes the real
handler through an injected transport and verifies exact retry-buffer identity,
correct signature/schema/conflict responses, fail-fast behavior, bounded
responses and exclusion of secret/signature/payload content from results. It
has not sent requests to a deployed endpoint.

The initial plain network command could not reach the proxy inside the command
sandbox; using the execution tool's network permission restored normal proxy
access. An initial npm install hit the read-only home cache; the writable `/tmp`
cache resolved it. A first typecheck caught an optional test response status;
that test adapter was corrected before the successful runs above. Initial tsx
execution could not create its IPC socket in the restricted command sandbox;
normal network-enabled execution passed. These setup failures are not AWS defects.

The previous profile-dependent SAM failure is resolved for local validation by
`scripts/sam-offline.sh`: temporary empty config/credential files, deliberately
dummy keys, no selected profile, metadata lookup disabled, a writable SAM state
directory, and only validate/build operations allowed. Real deployment uses the
operator's real approved profile separately. No injected identity was replaced;
this environment reports no configured outbound identities or secret bindings.

Focused source/template review reconfirmed authentication before parsing,
conditional acquisition, consistent conflict reads, completion/failure owner
fences, atomic event persistence, scoped table/secret/log IAM, and SAM's HttpApi
route declaration that generates invocation permission. Live generated policy
and log-delivery behavior still require deployed inspection. No material intake
implementation defect was found requiring architectural changes.

Historical validations above and in the study guide remain unchanged. The
original Express/PostgreSQL source and tests were preserved; workers/HTTP probes
were not rerun in this completion session. The earlier Node 22 import remains
historical; this session's import ran under Node 24. Live AWS account selection,
IAM, endpoint transport, Secrets Manager, CloudWatch, TTL deletion, PITR restore,
load/cost behavior and teardown remain unverified. Follow
[AWS_DEPLOYMENT_EVIDENCE.md](AWS_DEPLOYMENT_EVIDENCE.md) after explicit approval.
