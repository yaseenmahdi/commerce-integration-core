import test from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, computeTiktokSla, nextSlaAction } from "./sla.js";

test("addBusinessDays skips Saturday and Sunday", () => {
  const friday = new Date("2026-08-21T15:00:00Z");
  const plusTwo = addBusinessDays(friday, 2);
  assert.equal(plusTwo.toISOString().slice(0, 10), "2026-08-25");
});

test("TikTok internal tracking clock is 24h while dispatch is 2 business days", () => {
  const start = new Date("2026-08-24T16:00:00Z");
  const clock = computeTiktokSla(start, 24, 12);
  assert.equal(clock.trackingUploadBy.toISOString(), "2026-08-25T16:00:00.000Z");
  assert.equal(clock.escalateAt.toISOString(), "2026-08-25T04:00:00.000Z");
  assert.equal(clock.dispatchBy.toISOString().slice(0, 10), "2026-08-26");
  assert.equal(clock.autoCancelBy.toISOString().slice(0, 10), "2026-08-31");
});

test("SLA action escalates before the 24h upload deadline", () => {
  const start = new Date("2026-08-24T16:00:00Z");
  const clock = computeTiktokSla(start, 24, 12);
  assert.equal(nextSlaAction(new Date("2026-08-24T18:00:00Z"), clock, false), "poll_supplier");
  assert.equal(nextSlaAction(new Date("2026-08-25T05:00:00Z"), clock, false), "escalate");
  assert.equal(nextSlaAction(new Date("2026-08-25T17:00:00Z"), clock, false), "upload_tracking");
  assert.equal(nextSlaAction(new Date("2026-08-27T00:00:00Z"), clock, false), "breach");
  assert.equal(nextSlaAction(new Date("2026-08-27T00:00:00Z"), clock, true), "wait");
});
