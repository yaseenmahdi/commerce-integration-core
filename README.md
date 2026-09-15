# Commerce Integration Core

[![CI](https://github.com/yaseenmahdi/commerce-integration-core/actions/workflows/ci.yml/badge.svg)](https://github.com/yaseenmahdi/commerce-integration-core/actions/workflows/ci.yml)

Backend integration platform for normalizing supplier catalog data, applying channel-specific commerce rules, persisting inventory and order state, verifying webhooks, and monitoring fulfillment SLAs across multiple commerce channels.

The project focuses on the integration layer between external supplier systems and sales channels: API adapters, canonical data modeling, policy enforcement, idempotent event handling, scheduled workers, and operational state.

## Highlights

- **Supplier normalization** — shared product and variant models behind CJ REST and Zendrop MCP adapters.
- **Policy engine** — evaluates warehouse origin, stock, transit windows, GTIN/packaging requirements, and channel eligibility.
- **PostgreSQL persistence** — canonical catalog, inventory snapshots, channel listings, orders, webhook events, sync jobs, and SLA watches.
- **Webhook security** — HMAC verification with timing-safe comparison for Shopify, TikTok Shop, Walmart, and CJ event routes.
- **Idempotent processing** — database uniqueness constraints prevent duplicate webhook/order processing.
- **Resilient API access** — bounded retry/backoff with jitter and `Retry-After` support.
- **Scheduled operations** — inventory and fulfillment-SLA workers registered with `node-cron`.
- **Automated verification** — unit tests cover policy rules, SLA behavior, listing mapping, connector behavior, and webhook signatures.

## Architecture

```mermaid
flowchart LR
  SUPPLIERS[Supplier APIs] --> CONNECTORS[Connector adapters]
  CONNECTORS --> POLICY[Policy engine]
  POLICY --> DB[(PostgreSQL)]
  POLICY --> MAPPER[Channel payload mapper]
  MAPPER --> DB

  CHANNELS[Commerce channels] --> WEBHOOKS[Express webhooks]
  WEBHOOKS --> VERIFY[HMAC + idempotency]
  VERIFY --> DB

  WORKERS[Scheduled workers] --> DB
  WORKERS --> SUPPLIERS
```

More detail: [Architecture](docs/ARCHITECTURE.md) · [Operations](docs/OPERATIONS.md) · [Design decisions](docs/DESIGN_DECISIONS.md)

## Tech stack

- TypeScript / Node.js
- Express
- PostgreSQL 16
- Docker Compose
- Zod configuration validation
- Pino structured logging
- `node-cron` scheduled workers
- Node test runner

## Quick start

Requirements: Node.js 22+ and Docker.

```bash
git clone https://github.com/yaseenmahdi/commerce-integration-core.git
cd commerce-integration-core
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run dev
```

PowerShell equivalent for the environment file:

```powershell
Copy-Item .env.example .env
```

Verify the service:

```text
GET http://localhost:8080/health
```

External supplier connectors are disabled in `.env.example`, so local setup does not require API credentials just to start the database or run the test suite.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

The tests are designed to run without live supplier or marketplace credentials.

## Project structure

```text
src/
  connectors/   supplier clients, normalized types, retry/backoff, listing mapping
  database/     PostgreSQL pool and persistence helpers
  enrichment/   optional catalog scoring and listing-copy helpers
  policy/       shipping/channel eligibility and fulfillment-SLA rules
  webhooks/     signature verification and inbound event routes
  workers/      inventory synchronization and SLA monitoring
scripts/        migrations and manual worker entry points
sql/            PostgreSQL schema
docs/           architecture, operations, and design notes
```

## Security and reliability

- Credentials are loaded from environment variables and excluded from version control.
- Webhooks are authenticated before processing.
- Inbound events and orders use database-backed idempotency.
- External HTTP calls use retry/backoff behavior.
- Synchronization and SLA state are persisted instead of relying on process memory.
- Supplier connectors and optional enrichment are disabled by default in the example environment.

## Current scope

This repository prepares and stores channel-specific listing payloads and processes inbound integration events. Live marketplace publishing and automated supplier purchasing are intentionally not enabled by default.

## Why this project

Commerce APIs often disagree on data shape, authentication, fulfillment rules, and lifecycle state. This project explores the backend engineering required to put a stable integration layer between those systems rather than coupling application logic directly to any single external API.
