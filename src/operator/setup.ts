import type { Settings } from '../config/settings.ts';
import { DevinError } from '../devin/errors.ts';
import type { DevinSetupClient, KnowledgeNote } from '../devin/setup.ts';
import type { RepositoryAdmin, RepositoryLabel } from '../tracker/types.ts';
import { PLAYBOOK_ROUTES, samePlaybookText, type PlaybookRoute } from '../orchestrator/playbooks.ts';
import { desiredLabels, desiredNotes, ISSUE_FORM_PATH, issueForm, playbookTitle } from './assets.ts';

/**
 * `setup` for the configured target repository: reads current GitHub and Devin state, plans only the
 * changes that differ, then (unless dry-run) applies them. Only resources named for or pinned to the target
 * are read for comparison and written; organization-wide resources are never changed.
 */

export interface PlannedChange {
  system: 'GitHub' | 'Devin';
  resource: string;
  action: 'create' | 'update' | 'enable' | 'trigger';
  reason: string;
  apply: () => Promise<string | null>;
}

export interface SetupPlan {
  target: string;
  changes: PlannedChange[];
  unchanged: string[];
}

export interface SetupInputs {
  settings: Settings;
  github: RepositoryAdmin;
  devin: DevinSetupClient;
  /** Rendered Playbook body per route (`prompts/playbook-<route>.md`). */
  playbookBodies: Readonly<Record<PlaybookRoute, string>>;
  /** Target environment blueprint YAML. */
  blueprint: string;
  pitfalls: readonly string[];
  pitfallsFile: string;
}

/** Setup cannot continue; nothing has been changed. */
export class SetupStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupStopped';
  }
}

export function repositoryAccessMessage(target: string): string {
  return (
    `Devin cannot reach ${target}. Grant the Devin GitHub App access to this repository in the Devin web app ` +
    '(Settings > Connections > GitHub; with an enterprise account, Settings > Repositories), then run setup ' +
    'again. Setup never grants repository access itself and made no changes.'
  );
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

function labelDifferences(current: RepositoryLabel, wanted: RepositoryLabel): string[] {
  const differences: string[] = [];
  if (current.name !== wanted.name) differences.push(`name ${JSON.stringify(current.name)}`);
  if (current.color.toLowerCase() !== wanted.color) differences.push(`color ${current.color}`);
  if (current.description !== wanted.description) differences.push('description');
  return differences;
}

export async function planSetup(inputs: SetupInputs): Promise<SetupPlan> {
  const { settings, github, devin } = inputs;
  const target = `${github.repo.owner}/${github.repo.name}`;
  const targetLower = target.toLowerCase();
  const changes: PlannedChange[] = [];
  const unchanged: string[] = [];

  // Devin must reach the target before anything is planned, so a missing grant changes nothing anywhere.
  const reachable = await devin.listRepositories([target]);
  if (!reachable.some((repository) => repository.repo_path.toLowerCase() === targetLower)) {
    throw new SetupStopped(repositoryAccessMessage(target));
  }

  // GitHub labels: only the four workflow labels; other labels are never read for change or touched.
  const existing = await github.listLabels();
  for (const wanted of desiredLabels(settings.labels)) {
    const resource = `label "${wanted.name}"`;
    const current = existing.find((label) => label.name.toLowerCase() === wanted.name.toLowerCase());
    if (current === undefined) {
      changes.push({
        system: 'GitHub',
        resource,
        action: 'create',
        reason: `color ${wanted.color}, "${wanted.description}"`,
        apply: async () => {
          await github.createLabel(wanted);
          return null;
        },
      });
      continue;
    }
    const differences = labelDifferences(current, wanted);
    if (differences.length === 0) {
      unchanged.push(`GitHub ${resource}`);
      continue;
    }
    changes.push({
      system: 'GitHub',
      resource,
      action: 'update',
      reason: `differs: ${differences.join(', ')}`,
      apply: async () => {
        await github.updateLabel(current.name, wanted);
        return null;
      },
    });
  }

  // GitHub issue form.
  const form = issueForm(settings.labels);
  const file = await github.getFile(ISSUE_FORM_PATH);
  if (file !== null && sameText(file.content, form)) {
    unchanged.push(`GitHub issue form ${ISSUE_FORM_PATH}`);
  } else {
    changes.push({
      system: 'GitHub',
      resource: `issue form ${ISSUE_FORM_PATH}`,
      action: file === null ? 'create' : 'update',
      reason: file === null ? 'missing on the default branch' : 'content differs',
      apply: async () => {
        await github.putFile(ISSUE_FORM_PATH, {
          content: form,
          message: `${file === null ? 'Add' : 'Update'} Bug Smasher bug issue form`,
          sha: file?.sha ?? null,
        });
        return null;
      },
    });
  }

  // One Devin Playbook per route, each identified by its target-specific title.
  const existingPlaybooks = await devin.listPlaybooks();
  for (const route of PLAYBOOK_ROUTES) {
    const title = playbookTitle(target, route);
    const body = inputs.playbookBodies[route];
    const playbooks = existingPlaybooks.filter((playbook) => playbook.title === title);
    if (playbooks.length > 1) {
      throw new SetupStopped(`Several Devin Playbooks are titled "${title}"; remove the extras in the Devin web app and run setup again. No changes were made.`);
    }
    const playbook = playbooks[0];
    if (playbook !== undefined && samePlaybookText(playbook.body, body)) {
      unchanged.push(`Devin Playbook "${title}"`);
    } else {
      changes.push({
        system: 'Devin',
        resource: `Playbook "${title}"`,
        action: playbook === undefined ? 'create' : 'update',
        reason: playbook === undefined ? 'missing' : 'body differs',
        apply: async () => {
          if (playbook === undefined) await devin.createPlaybook({ title, body });
          else await devin.updatePlaybook(playbook.playbook_id, { title, body, macro: playbook.macro });
          return null;
        },
      });
    }
  }

  // Knowledge notes pinned to the target only; notes pinned elsewhere or unpinned are never considered.
  const pinned = (await devin.listKnowledgeNotes({ pinnedRepo: target })).filter(
    (note) => note.pinned_repo !== null && note.pinned_repo.toLowerCase() === targetLower,
  );
  for (const wanted of desiredNotes(target, settings, inputs.pitfalls, inputs.pitfallsFile)) {
    const resource = `Knowledge note "${wanted.name}"`;
    const matches = pinned.filter((note) => note.name === wanted.name);
    if (matches.length > 1) {
      throw new SetupStopped(`Several Knowledge notes pinned to ${target} are named "${wanted.name}"; remove the extras and run setup again. No changes were made.`);
    }
    const current: KnowledgeNote | undefined = matches[0];
    if (current !== undefined && current.is_enabled && sameText(current.body, wanted.body) && current.trigger === wanted.trigger) {
      unchanged.push(`Devin ${resource}`);
      continue;
    }
    const input = { ...wanted, pinnedRepo: target };
    changes.push({
      system: 'Devin',
      resource,
      action: current === undefined ? 'create' : 'update',
      reason: current === undefined ? `missing (pinned to ${target})` : noteDrift(current, wanted),
      apply: async () => {
        if (current === undefined) await devin.createKnowledgeNote(input);
        else await devin.updateKnowledgeNote(current.note_id, { ...input, isEnabled: true });
        return null;
      },
    });
  }

  // Repository indexing.
  let indexed = false;
  try {
    indexed = (await devin.getRepositoryIndexing(target)).indexing_enabled;
  } catch (error) {
    if (!(error instanceof DevinError && error.kind === 'not-found')) throw error;
  }
  if (indexed) {
    unchanged.push(`Devin indexing for ${target}`);
  } else {
    changes.push({
      system: 'Devin',
      resource: `indexing for ${target}`,
      action: 'enable',
      reason: 'not enabled',
      apply: async () => {
        await devin.indexRepository(target);
        return null;
      },
    });
  }

  // Target repository blueprint (creating it also adds the repository to the environment), then a build.
  const blueprints = (await devin.listBlueprints(target)).filter(
    (blueprint) => blueprint.type === 'repo' && blueprint.repo_name !== null && blueprint.repo_name.toLowerCase() === targetLower,
  );
  if (blueprints.length > 1) {
    throw new SetupStopped(`Several Devin blueprints exist for ${target}; keep one in the Devin web app and run setup again. No changes were made.`);
  }
  const blueprint = blueprints[0];
  let blueprintMatches = false;
  if (blueprint !== undefined) {
    const current = await devin.fetchDownload('get-blueprint-contents', await devin.getBlueprintContents(blueprint.blueprint_id));
    blueprintMatches = sameText(current, inputs.blueprint);
  }
  const buildChange = (reason: string): PlannedChange => ({
    system: 'Devin',
    resource: 'environment build',
    action: 'trigger',
    reason,
    apply: async () => {
      const build = await devin.triggerBuild();
      return `build ${build.build_id} is ${build.status}; check it with: npm run env-status -- ${build.build_id}`;
    },
  });
  if (blueprint !== undefined && blueprintMatches) {
    unchanged.push(`Devin blueprint for ${target}`);
    const blueprintUpdated = toMillis(blueprint.updated_at);
    const builtSince =
      blueprintUpdated === null ||
      (await devin.listBuilds()).some((build) => {
        const created = toMillis(build.created_at ?? build.started_at);
        return created !== null && created >= blueprintUpdated;
      });
    if (builtSince) unchanged.push('Devin environment build');
    else changes.push(buildChange('no build has started since the blueprint was last updated'));
  } else {
    changes.push({
      system: 'Devin',
      resource: `blueprint for ${target}`,
      action: blueprint === undefined ? 'create' : 'update',
      reason: blueprint === undefined ? 'missing (also adds the repository to the environment)' : 'contents differ',
      apply: async () => {
        if (blueprint === undefined) await devin.createBlueprint({ contents: inputs.blueprint, repoName: target });
        else await devin.updateBlueprint(blueprint.blueprint_id, { contents: inputs.blueprint });
        return null;
      },
    });
    changes.push(buildChange('the blueprint changed (updates never start a build by themselves)'));
  }

  return { target, changes, unchanged };
}

function noteDrift(current: KnowledgeNote, wanted: { body: string; trigger: string }): string {
  if (!sameText(current.body, wanted.body)) return 'body differs';
  if (current.trigger !== wanted.trigger) return 'trigger differs';
  return 'disabled';
}

/** Devin timestamps: Unix seconds (values above 10^12 as milliseconds) or ISO strings. */
function toMillis(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = /^\d+(\.\d+)?$/.test(value.trim()) ? toMillis(Number(value)) : Date.parse(value);
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function describeChange(change: PlannedChange): string {
  return `${change.action} ${change.system} ${change.resource} (${change.reason})`;
}
