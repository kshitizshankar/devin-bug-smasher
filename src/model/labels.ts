import type { LabelSettings } from '../config/settings.ts';
import type { BugRecord } from './types.ts';

/** Work requested by the workflow labels currently on a GitHub issue. */
export type LabelRoute = 'triage' | 'fix' | 'feature' | 'engineer';

export interface LabelResolution {
  route: LabelRoute | null;
  /** Set when the labels request incompatible work; automatic dispatch must be refused. */
  conflict: string | null;
}

function hasLabel(labels: readonly string[], label: string): boolean {
  const wanted = label.toLowerCase();
  return labels.some((candidate) => candidate.toLowerCase() === wanted);
}

/**
 * Resolves the workflow route requested by an issue's labels (GitHub label names are case-insensitive).
 *
 * 1. The engineer label wins over every other workflow label.
 * 2. Feature and bug-fix labels together are a conflict: no route, dispatch refused.
 * 3. Fix wins over triage (label moves add the destination repair label before removing the source).
 * 4. Feature wins over triage: feature work goes straight to Fix.
 * 5. Otherwise triage, or no route when no workflow label is present.
 */
export function resolveLabels(labels: readonly string[], settings: LabelSettings): LabelResolution {
  const triage = hasLabel(labels, settings.triage);
  const fix = hasLabel(labels, settings.fix);
  const feature = hasLabel(labels, settings.feature);

  if (hasLabel(labels, settings.engineer)) return { route: 'engineer', conflict: null };
  if (feature && fix) {
    return {
      route: null,
      conflict:
        `Both "${settings.feature}" (feature) and "${settings.fix}" (bug fix) are present; ` +
        'remove one so the work kind is unambiguous',
    };
  }
  if (fix) return { route: 'fix', conflict: null };
  if (feature) return { route: 'feature', conflict: null };
  if (triage) return { route: 'triage', conflict: null };
  return { route: null, conflict: null };
}

export function workflowLabelsPresent(labels: readonly string[], settings: LabelSettings): string[] {
  return [settings.triage, settings.fix, settings.engineer, settings.feature].filter((label) =>
    hasLabel(labels, label),
  );
}

export interface IntakeEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * An issue is enrolled only when a workflow label is present or a record already exists. An unlabelled,
 * unknown issue is not enrolled; it may still be displayed as Backlog (see `presentBug`).
 */
export function intakeEligibility(
  existing: BugRecord | undefined,
  labels: readonly string[],
  settings: LabelSettings,
): IntakeEligibility {
  if (existing !== undefined) return { eligible: true, reason: 'A stored record already exists' };
  const present = workflowLabelsPresent(labels, settings);
  if (present.length > 0) {
    return { eligible: true, reason: `Workflow label present: ${present.join(', ')}` };
  }
  return { eligible: false, reason: 'No workflow label and no stored record' };
}
