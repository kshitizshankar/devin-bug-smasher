/**
 * ACU readings. Devin reports `acus_consumed` / `total_acus` as numbers; a zero or missing value is
 * treated as unavailable (usage not reported yet), never as a real zero, so no cost is derived from it.
 */
export type AcuReading =
  | { status: 'reported'; acus: number }
  | { status: 'unavailable'; reason: 'zero-reported' | 'not-reported' | 'forbidden' | 'not-found' };

export function acuReading(value: unknown): AcuReading {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { status: 'unavailable', reason: 'not-reported' };
  if (value === 0) return { status: 'unavailable', reason: 'zero-reported' };
  return { status: 'reported', acus: value };
}

/** ACUs for the shared model's `SessionInsights.acuUsed`: null unless actually reported. */
export function acuUsed(reading: AcuReading): number | null {
  return reading.status === 'reported' ? reading.acus : null;
}

/** Dollar cost, only when both a reported ACU figure and a configured ACU price exist. */
export function estimateCostUsd(reading: AcuReading, acuPriceUsd: number | null): number | null {
  if (reading.status !== 'reported' || acuPriceUsd === null || !Number.isFinite(acuPriceUsd) || acuPriceUsd < 0) {
    return null;
  }
  return Math.round(reading.acus * acuPriceUsd * 100) / 100;
}

/** Inclusive time window for metrics and consumption, sent as Unix seconds (UTC). */
export interface TimeWindow {
  after: Date;
  before: Date;
}

export const MAX_WINDOW_DAYS = 100;

export function windowProblems(window: TimeWindow): string[] {
  const problems: string[] = [];
  const after = window.after.getTime();
  const before = window.before.getTime();
  if (!Number.isFinite(after) || !Number.isFinite(before)) problems.push('time window dates must be valid');
  else {
    if (before <= after) problems.push('time window `before` must be later than `after`');
    if (before - after > MAX_WINDOW_DAYS * 86_400_000) problems.push(`time window must be ${MAX_WINDOW_DAYS} days or less`);
  }
  return problems;
}

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
