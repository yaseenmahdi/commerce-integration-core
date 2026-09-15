/** US federal weekday holidays that affect TikTok Shop business-day SLAs. */
const US_FEDERAL_MONTH_DAY = new Set([
  "01-01",
  "06-19",
  "07-04",
  "11-11",
  "12-25",
]);

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function isObservedUsHoliday(date: Date): boolean {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return US_FEDERAL_MONTH_DAY.has(`${mm}-${dd}`);
}

export function isBusinessDay(date: Date): boolean {
  return !isWeekend(date) && !isObservedUsHoliday(date);
}

export function addBusinessDays(start: Date, days: number): Date {
  const cursor = new Date(start.getTime());
  let added = 0;
  while (added < days) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor)) added += 1;
  }
  return cursor;
}

export type SlaClock = {
  awaitingShipmentAt: Date;
  trackingUploadBy: Date;
  dispatchBy: Date;
  escalateAt: Date;
  autoCancelBy: Date;
};

/**
 * TikTok Shop US (regular orders):
 * - Dispatch SLA: In Transit (carrier scan) within 2 business days of Awaiting Shipment.
 * - Auto-cancel: no tracking in Seller Center within 5 business days.
 * Internal rule: attempt tracking upload within TIKTOK_TRACKING_SLA_HOURS (default 24h)
 * so we never lean on the platform's 5-day cancel window.
 */
export function computeTiktokSla(
  awaitingShipmentAt: Date,
  trackingSlaHours = 24,
  escalateHours = 12,
): SlaClock {
  const trackingUploadBy = new Date(awaitingShipmentAt.getTime() + trackingSlaHours * 3600_000);
  const escalateAt = new Date(awaitingShipmentAt.getTime() + escalateHours * 3600_000);
  return {
    awaitingShipmentAt,
    trackingUploadBy,
    dispatchBy: addBusinessDays(awaitingShipmentAt, 2),
    escalateAt,
    autoCancelBy: addBusinessDays(awaitingShipmentAt, 5),
  };
}

export type SlaAction = "poll_supplier" | "upload_tracking" | "escalate" | "wait" | "breach";

export function nextSlaAction(now: Date, clock: SlaClock, hasTracking: boolean): SlaAction {
  if (hasTracking) return "wait";
  if (now >= clock.dispatchBy) return "breach";
  if (now >= clock.trackingUploadBy) return "upload_tracking";
  if (now >= clock.escalateAt) return "escalate";
  return "poll_supplier";
}
