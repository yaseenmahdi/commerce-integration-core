# Operations

## Local setup

Requirements:

- Node.js 22+
- Docker with Docker Compose
- PostgreSQL 16 when not using the included Compose service

Create a local environment file:

```bash
cp .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
npm run db:migrate
```

Run the service:

```bash
npm run dev
```

The health endpoint is available at `GET /health`.

## Tests

The unit test suite does not require real supplier or marketplace credentials:

```bash
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks on every push to `main` and on pull requests.

## External integrations

Supplier connectors are disabled by default. To exercise a real connector:

1. Add the required credential to `.env`.
2. Enable only the connector you intend to test.
3. Use a sandbox/test environment when the external platform provides one.
4. Start with CLI workers before enabling scheduled execution.

Never commit `.env`, access tokens, webhook secrets, private keys, or exported marketplace data.

## Database

The Compose service initializes PostgreSQL with `sql/schema.sql`. To apply the schema manually:

```bash
npm run db:migrate
```

Runtime tables include products, product variants, inventory snapshots, channel listings, orders, webhook events, synchronization jobs, and SLA watches.

## Workers

Run inventory synchronization manually:

```bash
npm run worker:inventory
```

Run the SLA watcher manually:

```bash
npm run worker:sla
```

The application also registers both workers with `node-cron` using the schedules in `.env`.

## Catalog qualification

The optional catalog research command evaluates supplier variants against configurable cost, inventory, weight, policy, and enrichment rules:

```bash
npm run research:products
```

Generated reports are written to `output/` and are intentionally excluded from version control.
