# Portfolio evidence and public summary

## Accurate summary available now

Commerce Integration Core includes an additive TypeScript serverless intake path
for signed order notifications. API Gateway HTTP API routes requests to Lambda;
raw-byte HMAC verification and strict schema validation precede DynamoDB writes.
Conditional leases select one owner, stale-owner fencing protects completion,
and atomic persistence supports safe duplicate acknowledgements after uncertain
responses. A scoped runtime IAM role permits only the required table, secret,
and logging operations. SAM packages the infrastructure and Lambda bundle.

The project preserves its original Express/PostgreSQL application. Automated
coverage includes authentication boundaries, secret caching, failure recovery,
real DynamoDB Local conditional writes, and a synthetic endpoint demonstration
helper. The implementation, documentation, and validation were AI-assisted;
independent author understanding is recorded separately in the study guide.

## Claims and required evidence

| Claim | Current support | Additional evidence needed |
| --- | --- | --- |
| Implemented signed durable notification intake | Source, unit tests, DynamoDB Local | Live AWS boundary validation |
| Prepared repeatable SAM deployment | Local lint/build and template review | Completed CloudFormation deployment |
| Tested acceptance, retries and rejection contracts | Local automated checks | Five live demo cases |
| Scoped runtime permissions | Template/source review | Deployed IAM and invocation policy inspection |
| Correlation logs omit sensitive content | Source and local tests | Actual CloudWatch/access-log inspection |
| Runs successfully in AWS | NOT CLAIMED | Deployment, endpoint, storage and log evidence |
| Safe cleanup verified | NOT CLAIMED | Approved teardown and residual inventory |
| Production ready/high availability/exactly once | NOT CLAIMED | Outside this demonstration's evidence |

After live verification, replace pending statements with dated observations and
links to sanitized [deployment evidence](AWS_DEPLOYMENT_EVIDENCE.md). Do not claim
native marketplace payload support, downstream order placement, permanent replay
protection, automatic recovery without sender retries, implemented EventBridge/
Step Functions/Bedrock, measured cost savings, or independently demonstrated
mastery without evidence. Seven-day completed-record retention, shared-key
trust, and exact-byte retries are explicit limitations.

## Suggested public evidence sequence

1. Architecture diagram and source walkthrough: authentication before parsing,
   conditional lease acquisition, atomic completion, lost-acknowledgement retry.
2. Reviewed source commit and CI; show actual counts with no skipped local tests.
3. After approval, completed sandbox stack and scoped permissions.
4. Synthetic five-case demo, matching completed row and correlated safe logs.
5. Retention/recovery tradeoffs, budget review, cleanup record, and lessons learned.

Use only synthetic data. Keep credentials, signatures and private account details
out of public artifacts. Link [validation history](VALIDATION.md),
[architecture](ARCHITECTURE.md), and the [living study guide](SERVERLESS_STUDY_GUIDE.md)
so reviewers can distinguish implementation, observed behavior and learning.
