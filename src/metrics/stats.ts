import type { Figure, FigureUnit, MetricWindow } from './types.ts';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const TREND_WEEKS = 8;
export const RECENT_DAYS = 30;

/** Start (Monday 00:00 UTC) of the week containing `at`. */
export function weekStart(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function date(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The week containing `now` (ending at `now`) and the seven before it, oldest first. */
export function trendWeeks(now: Date): MetricWindow[] {
  const current = weekStart(now).getTime();
  const weeks: MetricWindow[] = [];
  for (let index = TREND_WEEKS - 1; index >= 0; index -= 1) {
    const start = new Date(current - index * WEEK_MS);
    const end = index === 0 ? now : new Date(start.getTime() + WEEK_MS);
    weeks.push({ start: start.toISOString(), end: end.toISOString(), label: index === 0 ? `week of ${date(start)} (to date)` : `week of ${date(start)}` });
  }
  return weeks;
}

/** The last `days` days ending at `now`, and the same length immediately before it. */
export function recentWindow(now: Date, days = RECENT_DAYS): MetricWindow {
  return { start: new Date(now.getTime() - days * DAY_MS).toISOString(), end: now.toISOString(), label: `last ${days} days` };
}

export function previousWindow(now: Date, days = RECENT_DAYS): MetricWindow {
  const end = new Date(now.getTime() - days * DAY_MS);
  return { start: new Date(end.getTime() - days * DAY_MS).toISOString(), end: end.toISOString(), label: `previous ${days} days` };
}

export function pointInTime(now: Date): MetricWindow {
  return { start: null, end: now.toISOString(), label: 'now' };
}

export function allTime(end: string, label = 'all records'): MetricWindow {
  return { start: null, end, label };
}

export function inWindow(at: string | null | undefined, window: MetricWindow): boolean {
  if (at === null || at === undefined) return false;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return false;
  return (window.start === null || time >= Date.parse(window.start)) && time < Date.parse(window.end);
}

export function hoursBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS;
}

/** Median of the sorted sample: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest-rank percentile: the value at 1-based rank ceil(p × n) of the sorted sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function formatValue(unit: FigureUnit, value: number, numerator: number | null, denominator: number | null): string {
  switch (unit) {
    case 'ratio':
      return `${round(value * 100, 1)}% (${numerator ?? 0} of ${denominator ?? 0})`;
    case 'hours':
      return `${round(value, 1)} h`;
    case 'usd':
      return `$${value.toFixed(2)}`;
    case 'acus':
      return `${round(value, 2)} ACUs`;
    case 'lines':
      return `${value} lines`;
    case 'files':
      return `${value} files`;
    case 'timestamp':
      return new Date(value).toISOString();
    case 'count':
      return String(round(value, 2));
  }
}

export interface FigureBase {
  id: string;
  label: string;
  unit: FigureUnit;
  window: MetricWindow;
  source: string;
}

export const NO_DATA = 'No data';

export function valueFigure(
  base: FigureBase,
  value: number,
  parts: { numerator?: number | null; denominator?: number | null; samples: number; note?: string | null; display?: string },
): Figure {
  const numerator = parts.numerator ?? null;
  const denominator = parts.denominator ?? null;
  return {
    ...base,
    status: 'value',
    value,
    numerator,
    denominator,
    samples: parts.samples,
    display: parts.display ?? formatValue(base.unit, value, numerator, denominator),
    note: parts.note ?? null,
  };
}

export function noData(base: FigureBase, note: string, samples = 0): Figure {
  return { ...base, status: 'no-data', value: null, numerator: null, denominator: null, samples, display: NO_DATA, note };
}

export function unavailable(base: FigureBase, note: string, display = 'Unavailable'): Figure {
  return { ...base, status: 'unavailable', value: null, numerator: null, denominator: null, samples: 0, display, note };
}

/** A share; no samples is no data, never 0%. */
export function rate(base: Omit<FigureBase, 'unit'>, numerator: number, denominator: number, empty: string): Figure {
  const full = { ...base, unit: 'ratio' as const };
  if (denominator === 0) return noData(full, empty);
  return valueFigure(full, numerator / denominator, { numerator, denominator, samples: denominator });
}

/** A count of `numerator` among `samples` candidates; no candidates is no data, never 0. */
export function count(base: Omit<FigureBase, 'unit'>, numerator: number, samples: number, empty: string): Figure {
  const full = { ...base, unit: 'count' as const };
  if (samples === 0) return noData(full, empty);
  return valueFigure(full, numerator, { numerator, denominator: samples, samples });
}

export type Statistic = 'min' | 'median' | 'p90' | 'max';

export function statistic(values: readonly number[], stat: Statistic): number | null {
  if (values.length === 0) return null;
  if (stat === 'median') return median(values);
  if (stat === 'p90') return percentile(values, 0.9);
  return stat === 'min' ? Math.min(...values) : Math.max(...values);
}

/** A statistic over a sample; numerator and denominator do not apply, so they are `null`. */
export function sampleFigure(base: FigureBase, values: readonly number[], stat: Statistic, empty: string): Figure {
  const value = statistic(values, stat);
  if (value === null) return noData(base, empty);
  return valueFigure(base, value, { samples: values.length });
}
