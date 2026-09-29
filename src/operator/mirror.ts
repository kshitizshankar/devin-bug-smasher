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

export function mirrorBody(source: TrackerIssue): string {
  const author = source.author === null ? '' : ` by @${source.author.login}`;
  const opened = source.createdAt.slice(0, 10);
  const body = source.body.replace(MIRROR_MARKER, '').trim();
  return [
    `> Mirrored from [${source.key}](${source.url}) (opened${author} on ${opened}). Comments here are not copied back to the source issue.`,
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
