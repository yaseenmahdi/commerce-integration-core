# Design decisions

## Canonical internal model

Supplier and marketplace APIs expose different product, inventory, order, and fulfillment shapes. The application normalizes supplier responses before persistence so policy and downstream mapping code work against one internal model.

## Policy separated from connectors

Eligibility rules live under `src/policy/` rather than inside API clients. This keeps supplier-specific transport logic separate from business rules and makes the policy functions straightforward to unit test.

## Idempotent webhook processing

Inbound webhook events are recorded with a unique `(channel, external_event_id)` constraint. Orders also use unique channel/external-order identifiers and idempotency keys. Replayed events can therefore be acknowledged without creating duplicate order state.

## Persistent worker state

Synchronization jobs and SLA watches are stored in PostgreSQL rather than only in process memory. A service restart does not erase the last known state of an open order or synchronization run.

## HMAC verification before processing

Webhook signatures are validated before the application accepts an event. Timing-safe comparison is used for digest validation to avoid ordinary string-comparison behavior.

## Backoff around external APIs

Supplier APIs can throttle or fail transiently. Shared HTTP helpers use bounded retries, exponential backoff with jitter, and `Retry-After` support rather than immediately failing or retrying in a tight loop.

## Safe public defaults

The example configuration disables supplier connectors and optional LLM enrichment. Developers can run type checks and unit tests without external credentials, then opt into individual integrations locally.
