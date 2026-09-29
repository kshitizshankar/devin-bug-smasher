import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { playbookBody, syncedPlaybookIds } from '../src/orchestrator/playbooks.ts';
import { MAX_OTHER_OPEN_BUGS } from '../src/orchestrator/prompts.ts';
import type { TrackerIssue } from '../src/tracker/types.ts';
import { Harness, report } from './helpers/orchestrator.ts';

const IDS = { triage: 'playbook-triage-1', repair: 'playbook-repair-2', feature: 'playbook-feature-3' } as const;

let harness: Harness;

async function setup(t: TestContext, options: Parameters<typeof Harness.create>[0] = {}): Promise<Harness> {
  harness = await Harness.create(options);
  t.after(() => report(t, harness));
  return harness;
}

afterEach(async () => {
  await harness?.close();
});

/** Starts one session per route: triage (`needs-triage`), repair (`bug-smasher`) and feature. */
async function oneSessionPerRoute(h: Harness): Promise<{ triage: number; repair: number; feature: number }> {
  const triage = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Seen at 400px', labels: ['needs-triage'] });
  const repair = h.tracker.seedIssue({ title: 'Tooltip flickers', body: 'On hover', labels: ['bug-smasher'] });
  const feature = h.tracker.seedIssue({ title: 'SVG export', body: '## Acceptance criteria\n- Export as SVG', labels: ['devin-builds-feature'] });
  await h.cycle(2);
  return { triage: triage.number, repair: repair.number, feature: feature.number };
}

function createFor(h: Harness, title: string): { prompt: string; body: Record<string, unknown> } {
  const create = h.createRequests().find((request) => String(request.body.title).endsWith(title));
  assert.ok(create, `a session was created for ${title}`);
  return create;
}

/**
 * Gives the harness tracker the GitHub adapter's `listAllIssues` over `seeded` (current state, open and closed);
 * returns how many times it was called.
 */
function offerFullListing(h: Harness, seeded: readonly TrackerIssue[]): () => number {
  let listings = 0;
  Object.assign(h.tracker, {
    listAllIssues: async (): Promise<TrackerIssue[]> => {
      listings += 1;
      return Promise.all(seeded.map((issue) => h.tracker.getIssue(issue.number)));
    },
  });
  return () => listings;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('orchestrator: route Playbooks', () => {
  it('passes each route its own synced Playbook id and does not inline that Playbook', async (t) => {
    const h = await setup(t, { playbookIds: IDS });
    await oneSessionPerRoute(h);
    const sessions = [
      { title: 'Legend overlaps axis', route: 'triage', id: IDS.triage },
      { title: 'Tooltip flickers', route: 'repair', id: IDS.repair },
      { title: 'SVG export', route: 'feature', id: IDS.feature },
    ] as const;
    for (const session of sessions) {
      const create = createFor(h, session.title);
      assert.equal(create.body.playbook_id, session.id, `${session.route} session gets its Playbook id`);
      assert.ok(!create.prompt.includes(playbookBody(h.prompts, session.route)), `${session.route} Playbook text is not inlined`);
      assert.match(create.prompt, /Playbook attached to this session/);
    }
    const ids = sessions.map((session) => createFor(h, session.title).body.playbook_id);
    assert.equal(new Set(ids).size, 3, 'the three ids differ');
  });

  it('inlines each route Playbook exactly once and sends no id when none is synced', async (t) => {
    const h = await setup(t);
    await oneSessionPerRoute(h);
    for (const [title, route] of [['Legend overlaps axis', 'triage'], ['Tooltip flickers', 'repair'], ['SVG export', 'feature']] as const) {
      const create = createFor(h, title);
      assert.equal(create.body.playbook_id, null, `${route} session gets no Playbook id`);
      assert.equal(count(create.prompt, playbookBody(h.prompts, route)), 1, `${route} Playbook text appears exactly once`);
      assert.doesNotMatch(create.prompt, /Playbook attached to this session/);
    }
  });

  it('attaches only the synced routes and inlines the rest, never both for one session', async (t) => {
    const h = await setup(t, { playbookIds: { repair: IDS.repair } });
    await oneSessionPerRoute(h);
    for (const [title, route] of [['Legend overlaps axis', 'triage'], ['Tooltip flickers', 'repair'], ['SVG export', 'feature']] as const) {
      const create = createFor(h, title);
      const inlined = count(create.prompt, playbookBody(h.prompts, route));
      if (create.body.playbook_id === null) assert.equal(inlined, 1, `${route}: inlined once without an id`);
      else assert.equal(inlined, 0, `${route}: an attached Playbook is not inlined too`);
    }
    assert.equal(createFor(h, 'Tooltip flickers').body.playbook_id, IDS.repair);
  });

  it('resolves only Playbooks whose title and body match the repository files', async (t) => {
    const h = await setup(t);
    const target = 'acme/widgets';
    const playbook = (id: string, title: string, body: string) => ({ playbook_id: id, title, body, macro: null, updated_at: 1 });
    const ids = syncedPlaybookIds(
      [
        playbook('p-1', 'Bug Smasher triage: acme/widgets', `${playbookBody(h.prompts, 'triage')}\n`),
        playbook('p-2', 'Bug Smasher repair: acme/widgets', 'an outdated procedure'),
        playbook('p-3', 'Bug Smasher feature: acme/other', playbookBody(h.prompts, 'feature')),
      ],
      target,
      h.prompts,
    );
    assert.deepEqual(ids, { triage: 'p-1' }, 'outdated or other-target Playbooks fall back to the inlined text');
  });
});

describe('orchestrator: open bugs for the triage duplicate check', () => {
  it('lists the other open bugs by number and title, most recent first, without feature requests', async (t) => {
    const h = await setup(t);
    const a = h.tracker.seedIssue({ title: 'Axis labels clipped', labels: ['needs-engineer'] });
    const b = h.tracker.seedIssue({ title: 'Legend colors swapped', labels: ['needs-engineer'] });
    const c = h.tracker.seedIssue({ title: 'Zoom resets on resize', labels: ['needs-triage'] });
    h.tracker.seedIssue({ title: 'Dark mode', labels: ['devin-builds-feature'] });
    h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Seen at 400px', labels: ['needs-triage'] });
    await h.cycle(2);
    const prompt = createFor(h, 'Legend overlaps axis').prompt;
    const listed = [...prompt.matchAll(/^- #(\d+): (.*)$/gm)].map((match) => [Number(match[1]), match[2]]);
    assert.deepEqual(listed, [
      [c.number, 'Zoom resets on resize'],
      [b.number, 'Legend colors swapped'],
      [a.number, 'Axis labels clipped'],
    ]);
    assert.doesNotMatch(prompt, /Dark mode/);
  });

  it('says there are none when the bug is the only open one', async (t) => {
    const h = await setup(t);
    h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    await h.cycle(2);
    const prompt = createFor(h, 'Legend overlaps axis').prompt;
    assert.match(prompt, /There are no other open bugs in acme\/widgets/);
    assert.doesNotMatch(prompt, /BEGIN OPEN BUGS/);
  });

  it('lists open bugs nobody has labelled and tracked bugs that lost their label, but not closed ones', async (t) => {
    const h = await setup(t);
    const tracked = h.tracker.seedIssue({ title: 'Axis labels clipped', labels: ['needs-triage'] });
    await h.cycle(2);
    await h.tracker.removeLabel(tracked.number, 'needs-triage');
    const unlabelled = h.tracker.seedIssue({ title: 'Legend overlaps title' });
    const closed = h.tracker.seedIssue({ title: 'Legend missing' });
    await h.tracker.closeIssue(closed.number);
    const feature = h.tracker.seedIssue({ title: 'Dark mode', labels: ['devin-builds-feature'] });
    const triaged = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    offerFullListing(h, [tracked, unlabelled, closed, feature, triaged]);
    await h.cycle(2);
    const prompt = createFor(h, 'Legend overlaps axis').prompt;
    const listed = [...prompt.matchAll(/^- #(\d+): (.*)$/gm)].map((match) => [Number(match[1]), match[2]]);
    assert.deepEqual(listed, [
      [unlabelled.number, 'Legend overlaps title'],
      [tracked.number, 'Axis labels clipped'],
    ]);
  });

  it('lists every issue at most once per cycle, however many triage sessions it starts', async (t) => {
    const h = await setup(t);
    const listings = offerFullListing(h, [
      h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] }),
      h.tracker.seedIssue({ title: 'Zoom resets on resize', labels: ['needs-triage'] }),
    ]);
    await h.cycle(2);
    const dispatchCycles = new Set(h.trace.filter((event) => event.type === 'dispatch-intent').map((event) => event.cycle));
    assert.equal(h.createRequests().length, 2);
    assert.equal(dispatchCycles.size, 1, 'both triage sessions start in the same cycle');
    assert.equal(listings(), 1);
    assert.match(createFor(h, 'Zoom resets on resize').prompt, /^- #\d+: Legend overlaps axis$/m);
  });

  it('falls back to the issues the cycle lists when the full listing fails', async (t) => {
    const h = await setup(t);
    Object.assign(h.tracker, {
      listAllIssues: async (): Promise<TrackerIssue[]> => {
        throw new Error('simulated listing failure');
      },
    });
    const other = h.tracker.seedIssue({ title: 'Zoom resets on resize', labels: ['needs-engineer'] });
    h.tracker.seedIssue({ title: 'Unlabelled bug' });
    h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    await h.cycle(2);
    const prompt = createFor(h, 'Legend overlaps axis').prompt;
    assert.match(prompt, new RegExp(`^- #${other.number}: Zoom resets on resize$`, 'm'));
    assert.doesNotMatch(prompt, /Unlabelled bug/);
    assert.ok(h.trace.some((event) => event.type === 'error' && event.detail.during === 'listAllIssues'));
  });

  it('lists only the most recent bugs beyond the bound', async (t) => {
    const h = await setup(t);
    const others = [];
    for (let index = 1; index <= MAX_OTHER_OPEN_BUGS + 5; index += 1) {
      others.push(h.tracker.seedIssue({ title: `Older bug ${index}`, labels: ['needs-engineer'] }));
    }
    h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    await h.cycle(2);
    const prompt = createFor(h, 'Legend overlaps axis').prompt;
    const listed = [...prompt.matchAll(/^- #(\d+): /gm)].map((match) => Number(match[1]));
    assert.deepEqual(listed, others.slice(-MAX_OTHER_OPEN_BUGS).reverse().map((issue) => issue.number));
  });
});
