import type { LabelSettings } from '../config/settings.ts';
import type { DiffFinding, Recommendation, TriageFindings } from '../model/types.ts';

const RECOMMENDATION_TEXT: Record<Recommendation, string> = {
  devin_fix: 'Devin can fix this',
  needs_engineer: 'Hand to an engineer',
  close: 'Close the issue',
};

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? '- (none)' : items.map((item) => `- ${item}`).join('\n');
}

export function questionComment(question: string): string {
  return [
    '**Devin needs one answer to continue**',
    '',
    quote(question),
    '',
    'Reply with a comment on this issue. Your comment is passed to the same Devin session exactly as written.',
  ].join('\n');
}

/** One concise investigation summary. The recommendation stays a recommendation; a person decides. */
export function triageComment(findings: TriageFindings, labels: LabelSettings): string {
  return [
    `**Investigation: ${findings.title}**`,
    '',
    findings.summary,
    '',
    `**Reproduced:** ${findings.reproduced ? 'yes' : 'no'}. ${findings.reproductionNotes}`,
    '',
    '**Steps to reproduce**',
    findings.reproductionSteps.length === 0
      ? '- (none)'
      : findings.reproductionSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    '',
    `**Expected:** ${findings.expectedBehavior}`,
    `**Actual:** ${findings.actualBehavior}`,
    '',
    `**Suspected cause:** ${findings.suspectedCause}`,
    '',
    '**Affected files**',
    bullets(findings.affectedFiles.map((file) => `\`${file}\``)),
    '',
    `**Proposed verification:** ${findings.proposedTest.description} in \`${findings.proposedTest.file}\`, ` +
      'run with (proposed by Devin; not run by the service):',
    '```',
    findings.proposedTest.command,
    '```',
    '',
    `**Recommendation:** ${RECOMMENDATION_TEXT[findings.recommendation]} (${findings.confidence} confidence). ` +
      findings.reason,
    '',
    `This is a recommendation, not a decision. Add \`${labels.fix}\` to start the fix, ` +
      `\`${labels.engineer}\` to hand it to an engineer, or close the issue.`,
  ].join('\n');
}

export function triagePullRequestNotice(prUrls: readonly string[]): string {
  return [
    '**Investigation opened a pull request unexpectedly**',
    '',
    'Investigation must not change code. The service did not accept this as a fix and did not advance the issue:',
    bullets(prUrls),
  ].join('\n');
}

export function existingPullRequestComment(prNumber: number, prUrl: string, engineerLabel: string): string {
  return [
    `**Repair not started:** open pull request #${prNumber} (${prUrl}) already addresses this issue.`,
    '',
    `The issue was handed off with \`${engineerLabel}\` instead of opening a duplicate pull request.`,
  ].join('\n');
}

export function policyDecisionComment(action: 'fix' | 'engineer', rule: string, reasons: readonly string[]): string {
  const verb = action === 'fix' ? 'started the fix' : 'handed the issue to an engineer';
  return [`**Decision policy \`${rule}\` ${verb}.**`, '', bullets(reasons)].join('\n');
}

/** Findings that do not fail verification but that the person deciding the merge should see. */
export function verificationFlagsComment(prUrl: string, headSha: string, flags: readonly DiffFinding[]): string {
  return [
    `**Verification passed with a flag for review** (${prUrl}, commit \`${headSha.slice(0, 12)}\`)`,
    '',
    bullets(flags.map((flag) => (flag.file === '' ? `${flag.check}: ${flag.detail}` : `${flag.check} in \`${flag.file}\`: ${flag.detail}`))),
    '',
    'Some real fixes only delete code; check that this one removes the bug rather than the behaviour under test.',
  ].join('\n');
}
