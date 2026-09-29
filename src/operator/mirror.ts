import type { GitHubRepo } from '../config/settings.ts';
import type { RepositoryAdmin, Tracker, TrackerIssue } from '../tracker/types.ts';

/**
 * `mirror`: copies an issue from any readable repository into the configured target, recording where it came
 * from. The source is only read; every write goes to the target.
 */

const MIRROR_MARKER = /<!-- bug-smasher mirror-of=([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+) -->/g;

export function mirrorMarker(sourceKey: string): string {
  return `<!-- bug-smasher mirror-of=${sourceKey} -->`;
}

/** Source keys recorded in an issue body. */
export function mirroredFrom(body: string): string[] {
  return [...body.matchAll(MIRROR_MARKER)].map((match) => match[1] as string);
}

/**
 * Markdown that GitHub would render as a notification or cross-reference: links and autolinks to issues and
 * pull requests, `owner/repo#N` and bare `#N`/`GH-N` references, and `@user` or `@org/team` mentions.
 */
const ISSUE_URL = String.raw`https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/(?:issues|pull)\/\d+(?:[\/?#][^\s<>()\[\]\x60]*)?`;
const LIVE_REFERENCE = new RegExp(
  [
    String.raw`\[(?<linkText>[^\]\n]*)\]\(\s*<?(?<linkUrl>${ISSUE_URL})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`,
    String.raw`<(?<autolink>${ISSUE_URL})>`,
    String.raw`(?<url>${ISSUE_URL})`,
    String.raw`(?<![\w\/.@-])(?<qualified>[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+)\b`,
    String.raw`(?<![\w\/\x60@-])(?<mention>@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)(?![\w-])`,
    String.raw`(?<![\w&\/#\x60-])(?<issueRef>#\d+|GH-\d+)\b`,
  ].join('|'),
  'g',
);
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

function code(text: string): string {
  return `\`${text}\``;
}

function neutraliseReference(match: RegExpMatchArray): string {
  const groups = match.groups ?? {};
  if (groups.linkUrl !== undefined) return `${neutraliseText(groups.linkText ?? '')} (${code(groups.linkUrl)})`;
  if (groups.autolink !== undefined) return code(groups.autolink);
  if (groups.url !== undefined) {
    const trailing = TRAILING_PUNCTUATION.exec(groups.url)?.[0] ?? '';
    return code(groups.url.slice(0, groups.url.length - trailing.length)) + trailing;
  }
  return code(match[0]);
}

function neutraliseText(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(LIVE_REFERENCE)) {
    out.push(text.slice(last, match.index), neutraliseReference(match));
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out.join('');
}

/** Splits text outside fenced code blocks into inline code spans, which are kept, and prose, which is neutralised. */
function neutraliseProse(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const span of text.matchAll(/(?<!\x60)(\x60+)(?!\x60)[\s\S]*?(?<!\x60)\1(?!\x60)/g)) {
    out.push(neutraliseText(text.slice(last, span.index)), span[0]);
    last = span.index + span[0].length;
  }
  out.push(neutraliseText(text.slice(last)));
  return out.join('');
}

/**
 * Rewrites copied Markdown so that nothing in it notifies anyone or links to another issue: every `@mention`,
 * issue or pull request URL and issue reference outside code is put in code formatting. Fenced code blocks and
 * inline code are left as they are, since GitHub does not link inside them.
 */
export function neutraliseMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = (): void => {
    if (prose.length > 0) out.push(neutraliseProse(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (marker !== undefined && !(marker[0] === '\x60' && line.slice(line.indexOf(marker) + marker.length).includes('\x60'))) {
        flush();
        fence = { char: marker[0] as string, length: marker.length };
        out.push(line);
      } else {
        prose.push(line);
      }
    } else {
      out.push(line);
      if (marker !== undefined && marker[0] === fence.char && marker.length >= fence.length && /^ {0,3}[\x60~]+\s*$/.test(line)) fence = null;
    }
  }
  flush();
  return out.join('\n');
}

export function mirrorBody(source: TrackerIssue): string {
  const opened = source.createdAt.slice(0, 10);
  const body = neutraliseMarkdown(source.body.replace(MIRROR_MARKER, '').trim());
  return [
    `> Mirrored from ${code(source.key)} (opened on ${opened}). Comments here are not copied back to the source issue.`,
    '',
    body === '' ? '_The source issue has no description._' : body,
    '',
    mirrorMarker(source.key),
  ].join('\n');
}

export type MirrorResult =
  | { kind: 'duplicate'; source: TrackerIssue; existing: TrackerIssue; recordedSource: string }
  | { kind: 'planned'; source: TrackerIssue; title: string; body: string; labels: string[] }
  | { kind: 'created'; source: TrackerIssue; issue: TrackerIssue };

export interface MirrorInputs {
  source: { repo: GitHubRepo; number: number };
  sourceReader: Pick<Tracker, 'getIssue'>;
  target: Pick<Tracker, 'repo' | 'createIssue'> & Pick<RepositoryAdmin, 'listAllIssues'>;
  labels: string[];
  dryRun: boolean;
}

export async function mirrorIssue(inputs: MirrorInputs): Promise<MirrorResult> {
  const { repo, number } = inputs.source;
  const target = inputs.target.repo;
  if (repo.owner.toLowerCase() === target.owner.toLowerCase() && repo.name.toLowerCase() === target.name.toLowerCase()) {
    throw new Error(`The source ${repo.owner}/${repo.name}#${number} is the target repository; nothing to mirror`);
  }
  const source = await inputs.sourceReader.getIssue(number);
  const sourceKey = source.key.toLowerCase();
  for (const existing of await inputs.target.listAllIssues()) {
    const recordedSource = mirroredFrom(existing.body).find((key) => key.toLowerCase() === sourceKey);
    if (recordedSource !== undefined) return { kind: 'duplicate', source, existing, recordedSource };
  }
  const body = mirrorBody(source);
  if (inputs.dryRun) return { kind: 'planned', source, title: source.title, body, labels: inputs.labels };
  const issue = await inputs.target.createIssue({ title: source.title, body, labels: inputs.labels });
  return { kind: 'created', source, issue };
}
