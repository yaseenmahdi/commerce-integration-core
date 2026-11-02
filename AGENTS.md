# Repository guidance

- The existing TypeScript ESM application runs Express, PostgreSQL persistence,
  supplier connectors, policy rules, and scheduled workers. `src/serverless/`
  adds an independent HTTP API/Lambda/DynamoDB event receipt path; it does not
  replace the original app or place orders.
- Use Node.js 22+ (CI uses 24), `npm ci`, strict types, small named functions,
  and the existing two-space/semicolon style. Document exported contracts and
  security/concurrency decisions; avoid generic wrappers and trivial comments.
- Run `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run build:serverless` for serverless changes. Validate infrastructure with
  `sam validate --lint` and `sam build`. Local DynamoDB checks run separately via
  `npm run test:serverless:integration`; skipped tests are not passing checks.
- Authenticate exact raw bytes before JSON parsing. Never log payloads, headers,
  signatures, secrets, environment dumps, or raw SDK errors. Preserve conditional
  writes, lease-owner fencing, and atomic persistence/completion.
- Keep `.env`, local credentials, generated artifacts, and real signed fixtures
  out of Git. The Lambda obtains its signing secret from Secrets Manager.
- Preserve the Express/PostgreSQL workflow and original tests. Existing supplier
  boolean parsing, schema migration, and `npm start` path issues are separate
  follow-ups; avoid unrelated fixes.
- Use the existing isolated checkout. Do not create worktrees without request.
  Never force-push or push directly to main. AWS deployment, account connections,
  paid resources, repository settings changes, and PR merges require explicit
  user approval; local development and testing are permitted.
- For serverless teaching, use `docs/SERVERLESS_STUDY_GUIDE.md`. Teach one topic
  at a time and update its progress table and dated session log from actual
  learner answers and activities. Keep AI-executed checks separate from learner
  demonstrations, and preserve the historical evidence in `docs/VALIDATION.md`.
