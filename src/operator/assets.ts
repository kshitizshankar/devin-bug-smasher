import type { LabelSettings, Settings } from '../config/settings.ts';
import type { RepositoryLabel } from '../tracker/types.ts';

/**
 * Desired target-repository state written by `setup`: workflow labels, the bug issue form, the triage
 * Playbook and the repository-pinned Knowledge notes. Everything here derives from settings and repository
 * files; nothing describes the target beyond what the operator configured or recorded.
 */

export const ISSUE_FORM_PATH = '.github/ISSUE_TEMPLATE/bug-smasher-bug.yml';

const LABEL_STYLE: Record<keyof LabelSettings, { color: string; description: string }> = {
  triage: { color: 'fbca04', description: 'Bug Smasher: Devin investigates this issue' },
  fix: { color: '0e8a16', description: 'Bug Smasher: Devin repairs this issue' },
  engineer: { color: 'd93f0b', description: 'Bug Smasher: a person handles this issue' },
  feature: { color: '1d76db', description: 'Bug Smasher: Devin builds this feature' },
};

export function desiredLabels(labels: LabelSettings): RepositoryLabel[] {
  return (Object.keys(LABEL_STYLE) as (keyof LabelSettings)[]).map((role) => ({ name: labels[role], ...LABEL_STYLE[role] }));
}

function yamlString(text: string): string {
  return JSON.stringify(text);
}

export function issueForm(labels: LabelSettings): string {
  const description =
    `Report a bug. Bug Smasher starts work only after a maintainer adds ${labels.triage} (investigate) ` +
    `or ${labels.fix} (repair).`;
  return [
    'name: Bug report',
    `description: ${yamlString(description)}`,
    'title: "[Bug]: "',
    'body:',
    '  - type: textarea',
    '    id: what-happened',
    '    attributes:',
    '      label: What happened?',
    '      description: The behaviour you saw, including any error message.',
    '    validations:',
    '      required: true',
    '  - type: textarea',
    '    id: steps',
    '    attributes:',
    '      label: Steps to reproduce',
    '      description: The smallest set of steps or commands that shows the problem.',
    '      placeholder: "1. ...\\n2. ...\\n3. ..."',
    '    validations:',
    '      required: true',
    '  - type: textarea',
    '    id: expected',
    '    attributes:',
    '      label: Expected behaviour',
    '    validations:',
    '      required: true',
    '  - type: input',
    '    id: version',
    '    attributes:',
    '      label: Version or commit',
    '      description: Where you saw it, if known.',
    '    validations:',
    '      required: false',
    '',
  ].join('\n');
}

export function playbookTitle(target: string): string {
  return `Bug Smasher triage: ${target}`;
}

export interface DesiredNote {
  name: string;
  body: string;
  trigger: string;
}

const PRECEDENCE = "If this note and the repository's AGENTS.md disagree, follow AGENTS.md.";

/** Parses recorded pitfalls: one per non-empty line; Markdown bullets and headings are accepted. */
export function parsePitfalls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('<!--'))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => line !== '');
}

export function desiredNotes(target: string, settings: Settings, pitfalls: readonly string[], pitfallsFile: string): DesiredNote[] {
  const check = settings.checkCommand;
  const fastTests = [
    `Fast tests for ${target}, written by Bug Smasher setup from its configuration.`,
    '',
    check === null
      ? 'No test command is configured (CHECK_COMMAND), so Bug Smasher cannot verify fixes in this repository yet.'
      : `Bug Smasher verifies a fix by running only the new or changed test files with:\n\n    ${check}\n\n` +
        '`{files}` becomes the selected test files and `{results}` the JUnit report path. Run your new or ' +
        'changed tests the same way before opening a pull request.',
    '',
    settings.verify.setupCommand === null
      ? 'No dependency preparation command is configured (VERIFY_SETUP_COMMAND).'
      : `Dependencies are prepared first with: ${settings.verify.setupCommand}`,
    '',
    PRECEDENCE,
  ].join('\n');
  const image = settings.verify.image;
  const verification = [
    `Verification image for ${target}, written by Bug Smasher setup from its configuration.`,
    '',
    image === null
      ? 'No verification image is configured (VERIFY_IMAGE), so Bug Smasher reports verification as unavailable.'
      : `Bug Smasher runs regression tests in the container image ${image}.`,
    '',
    'Each run uses a fresh copy of the commit exported with `git archive` (no `.git` directory, remote or ' +
      'credentials). Dependency preparation runs with network access; the tests then run with the network cut. ' +
      'A proof passes only when the new tests pass on the pull request head and fail on its base, so tests ' +
      'that need network access, credentials or git history fail there.',
    '',
    PRECEDENCE,
  ].join('\n');
  const observed = [
    `Observed pitfalls in ${target}, copied by Bug Smasher setup from ${pitfallsFile}.`,
    '',
    pitfalls.length === 0 ? 'No pitfalls have been recorded for this repository yet.' : pitfalls.map((item) => `- ${item}`).join('\n'),
    '',
    PRECEDENCE,
  ].join('\n');
  return [
    { name: 'Bug Smasher: fast tests', body: fastTests, trigger: `Running, writing or selecting tests in ${target}` },
    { name: 'Bug Smasher: verification image', body: verification, trigger: `Preparing a fix in ${target} that Bug Smasher will verify` },
    { name: 'Bug Smasher: observed pitfalls', body: observed, trigger: `Investigating or fixing a bug in ${target}` },
  ];
}
