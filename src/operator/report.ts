import type { BugRecord } from '../model/types.ts';

/**
 * `report`: RESULTS.md from the records in the bug store only. It lists what each record holds and
 * calculates no metrics; a figure appears only when a record contains it.
 */

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderResults(records: readonly BugRecord[], storeLabel: string): string {
  const lines = [
    '# Bug Smasher results',
    '',
    `Written by \`report\` from the bug store (\`${storeLabel}\`). It lists only what the records contain; no metrics are calculated.`,
    '',
  ];
  if (records.length === 0) {
    lines.push('The bug store has no records yet, so there is nothing to report.', '');
    return lines.join('\n');
  }
  lines.push('| Issue | Kind | Stage | Route | Fix pull request | Verification results | Last update |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const record of [...records].sort((a, b) => a.key.localeCompare(b.key))) {
    const verifications = record.verifications.map((attempt) => attempt.result).join(', ');
    lines.push(
      `| ${cell(record.key)} | ${record.kind} | ${record.stage} | ${record.route ?? ''} | ${record.fix === null ? '' : cell(record.fix.prUrl)} | ${cell(verifications)} | ${record.updatedAt} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
