import type { CohortMetrics, Figure, KeyFigure, MetricsReport } from '../metrics/types.ts';

/** Inline Markdown text: HTML and link syntax escaped, newlines flattened. */
function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

/** Markdown table cell: inline text with pipes escaped. */
function cell(value: string): string {
  return text(value).replace(/\|/g, '\\|');
}

function windowText(figure: Figure): string {
  return figure.window.start === null ? `${figure.window.label} (to ${figure.window.end})` : `${figure.window.label} (${figure.window.start} to ${figure.window.end})`;
}

function part(value: number | null): string {
  return value === null ? '' : String(value);
}

export const FIGURE_HEADER = '| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |';
const FIGURE_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
export const ROW_HEADER = '| Issue | Cohort | Kind | Path | Decision | Pull request | Verification | Outcome |';
const ROW_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- |';

function figureRow(figure: Figure, reference: Figure | null = null): string {
  const referenceText = reference === null ? '' : `${reference.label}: ${reference.display} (samples ${reference.samples}; source: ${reference.source})`;
  return `| ${cell(figure.label)} | ${cell(figure.display)} | ${cell(referenceText)} | ${part(figure.numerator)} | ${part(figure.denominator)} | ${figure.samples} | ${cell(windowText(figure))} | ${cell(figure.source)} | ${cell(figure.note ?? '')} |`;
}

function table(lines: string[], rows: string[]): void {
  lines.push(FIGURE_HEADER, FIGURE_RULE, ...rows, '');
}

function keyRows(keys: CohortMetrics['keys']): string[] {
  const keyed = (key: KeyFigure): string => figureRow(key.figure, key.reference);
  return [
    keyed(keys.fixThroughput),
    keyed(keys.timeToFixMedian),
    figureRow(keys.timeToFixP90),
    keyed(keys.firstTimePass),
    keyed(keys.escapedFixes),
  ];
}

function cohortSections(lines: string[], cohort: CohortMetrics, heading: string): void {
  lines.push(`${heading} Four keys`, '');
  table(lines, keyRows(cohort.keys));
  lines.push(`${heading} Fix throughput, eight weeks`, '');
  table(lines, cohort.keys.trend.map((week) => figureRow(week.figure)));
  const excluded = cohort.keys.trend.flatMap((week) => week.excluded.map((item) => `- ${item.key} (${text(item.pullRequest)}): ${text(item.reason)}`));
  if (excluded.length > 0) lines.push('Merged fixes that did not count:', '', ...excluded, '');
  lines.push(`${heading} Flow and health`, '');
  const { flow, adoption } = cohort;
  table(lines, [
    ...flow.bugsIn,
    ...flow.openByStage,
    ...flow.longestWait,
    flow.resolution,
    flow.failure,
    ...flow.failureByReason,
    ...flow.fixSizeLines,
    ...flow.fixSizeFiles,
  ].map((figure) => figureRow(figure)));
  lines.push(`${heading} Adoption and trust`, '');
  table(lines, [
    ...adoption.peopleByWeek,
    ...adoption.peopleByAction,
    adoption.answerTime,
    ...adoption.decisionTime,
    adoption.unansweredQuestions,
    ...adoption.agreement,
    ...adoption.automation,
  ].map((figure) => figureRow(figure)));
}

/**
 * RESULTS.md from the shared metrics calculation: a row per record, then the headline numbers, then spend
 * with its source and read time. Every value is the calculation's own `display` text, unchanged.
 */
export function renderResults(report: MetricsReport, storeLabel: string): string {
  const lines = [
    '# Bug Smasher results',
    '',
    `Written by \`report\` from the bug store (\`${storeLabel}\`) at ${report.generatedAt}. Times are ${report.timezone}; weeks start on ${report.weekStartsOn} 00:00. Every figure comes from the shared metrics calculation the dashboard API reads.`,
    '',
    `Sources: ${text(report.sources.github)}. ${text(report.sources.devin)}. ${text(report.sources.orchestrator)}.`,
    '',
    '## Bugs',
    '',
  ];
  if (report.rows.length === 0) lines.push('The bug store has no records yet.', '');
  else {
    lines.push(ROW_HEADER, ROW_RULE);
    for (const row of report.rows) {
      lines.push(`| ${cell(row.key)} | ${cell(row.cohort)} | ${row.kind} | ${cell(row.path)} | ${cell(row.decision)} | ${cell(row.pullRequest)} | ${cell(row.verification)} | ${cell(row.outcome)} |`);
    }
    lines.push('');
  }

  lines.push('## Headline numbers', '');
  if (report.live === null) {
    lines.push(
      report.target === null
        ? 'GITHUB_REPO is not set, so no records count as live outcomes.'
        : `No live records for ${report.target}, so there are no live outcomes yet.`,
      '',
    );
  } else {
    lines.push(`Live bugs of ${report.live.repository}: ${report.live.bugs} bugs, ${report.live.features} feature requests (never counted in bug outcomes).`, '');
    cohortSections(lines, report.live, '###');
  }
  lines.push('### Liveness', '');
  const { liveness } = report;
  table(lines, [liveness.lastCycle, liveness.workingSessions, liveness.verificationErrors, liveness.stalledSessions, ...liveness.knowledgeUsed].map((figure) => figureRow(figure)));

  lines.push('## Spend', '');
  const { cost } = report;
  lines.push(`Source: ${text(cost.sourceLabel)}`, '', `Read at: ${cost.readAt ?? 'not read'}`, '', `Scope: ${cost.scope}`, '');
  table(lines, [cost.totalSpend, cost.budgetRemaining, cost.costPerFixedBug, cost.costPerSession, ...cost.costPerSessionByRoute, cost.sessionsAtCap].map((figure) => figureRow(figure)));
  if (cost.largestSessions.length > 0) {
    lines.push('Largest sessions:', '', '| Session | Bug | Route | ACUs | Spend |', '| --- | --- | --- | --- | --- |');
    for (const session of cost.largestSessions) {
      lines.push(`| ${cell(session.id)} | ${cell(session.bugKey ?? '')} | ${session.route ?? ''} | ${session.acus} | $${session.usd.toFixed(2)} |`);
    }
    lines.push('');
  }

  lines.push('## Devin cross-check', '', report.crossCheck.note, '');
  table(lines, report.crossCheck.figures.flatMap((pair) => [figureRow(pair.devin), figureRow(pair.local)]));

  if (report.otherCohorts.length > 0) {
    lines.push('## Other cohorts', '', 'Reported separately; none of these count in live outcomes.', '');
    for (const cohort of report.otherCohorts) {
      lines.push(`### ${cohort.label}`, '', `${cohort.bugs} bugs, ${cohort.features} feature requests.`, '');
      cohortSections(lines, cohort, '####');
    }
  }
  return lines.join('\n');
}
