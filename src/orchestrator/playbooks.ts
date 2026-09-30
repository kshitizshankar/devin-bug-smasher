import type { Playbook } from '../devin/setup.ts';
import type { Prompts } from './prompts.ts';

/** Routes with their own Devin Playbook; `repair` and `feature` are both dispatched as the `fix` session route. */
export const PLAYBOOK_ROUTES = ['triage', 'repair', 'feature'] as const;

export type PlaybookRoute = (typeof PLAYBOOK_ROUTES)[number];

/** Devin Playbook ids by route; a missing route has no synced Playbook and its procedure is inlined instead. */
export type PlaybookIds = Readonly<Partial<Record<PlaybookRoute, string>>>;

/** Target-specific title that identifies a route's Playbook in the Devin organization. */
export function playbookTitle(target: string, route: PlaybookRoute = 'triage'): string {
  return `Bug Smasher ${route}: ${target}`;
}

/** The route's Playbook body, from `prompts/playbook-<route>.md` with the configured label names filled in. */
export function playbookBody(prompts: Prompts, route: PlaybookRoute): string {
  return prompts.renderPlaybook(route);
}

export function samePlaybookText(a: string, b: string): boolean {
  return a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

/**
 * Ids of the target's route Playbooks that are synced: exactly one Playbook carries the route's title and its
 * body matches the repository file. Missing, duplicated or outdated Playbooks are left out, so those routes
 * fall back to the inlined procedure.
 */
export function syncedPlaybookIds(playbooks: readonly Playbook[], target: string, prompts: Prompts): PlaybookIds {
  const ids: Partial<Record<PlaybookRoute, string>> = {};
  for (const route of PLAYBOOK_ROUTES) {
    const matches = playbooks.filter((playbook) => playbook.title === playbookTitle(target, route));
    const [playbook] = matches;
    if (matches.length === 1 && playbook !== undefined && samePlaybookText(playbook.body, playbookBody(prompts, route))) {
      ids[route] = playbook.playbook_id;
    }
  }
  return ids;
}
