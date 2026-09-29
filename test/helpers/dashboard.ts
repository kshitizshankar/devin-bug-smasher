import { mkdtemp, rm } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, type Env, type Settings } from '../../src/config/settings.ts';
import { Dashboard } from '../../src/dashboard/dashboard.ts';
import { DevinClient } from '../../src/devin/client.ts';
import { OfflineDevin } from '../../src/devin/offline.ts';
import type { BugRecord } from '../../src/model/types.ts';
import { createApp } from '../../src/server/app.ts';
import { BugStore } from '../../src/store/bug-store.ts';
import { InMemoryTracker } from '../../src/tracker/memory.ts';
import { API_KEY, ORG_ID } from './devin.ts';
import { Bug, headSha, mergeSha, NOW } from './metrics.ts';
import { LABEL } from './model.ts';

export const GITHUB_TOKEN = 'ghp_FixtureSecretToken0123456789abcdef';
export { API_KEY };

/** Settings of the fixture world: credentials configured (fake values) and machine-independent paths. */
export const FIXTURE_ENV: Env = {
  GITHUB_REPO: 'acme/widgets',
  GITHUB_TOKEN,
  DEVIN_API_KEY: API_KEY,
  DEVIN_ORG_ID: ORG_ID,
  CHECK_COMMAND: 'npm test -- {files}',
  STATIC_DIR: '/srv/bug-smasher/dist/web',
  VERIFY_WORK_DIR: '/srv/bug-smasher/data/verify',
};

/** Issue numbers of the fixture world; pull requests are numbered after the issues, as on GitHub. */
export const ISSUE = { merged: 1, recommendClose: 2, openPr: 3, waitingForReply: 4, noProviderData: 5, engineer: 6, notEnrolled: 7, verifying: 8 } as const;
export const PR = { merged: 9, openPr: 10, verifying: 11 } as const;

function records(): BugRecord[] {
  const merged = new Bug(ISSUE.merged, [LABEL.fix], '2026-03-02T09:00:00.000Z')
    .session('session-fix-1', '2026-03-02T09:05:00.000Z')
    .submit(PR.merged, headSha(PR.merged), '2026-03-02T15:00:00.000Z')
    .verify('pass', headSha(PR.merged), '2026-03-02T16:00:00.000Z')
    .merge(PR.merged, mergeSha(PR.merged), '2026-03-03T15:00:00.000Z')
    .verify('pass', mergeSha(PR.merged), '2026-03-03T15:10:00.000Z', 'post-merge');

  const recommendClose = new Bug(ISSUE.recommendClose, [LABEL.triage], '2026-03-10T10:00:00.000Z')
    .session('session-triage-2', '2026-03-10T10:01:00.000Z')
    .triaged('2026-03-10T11:00:00.000Z', { title: 'Tooltip flickers on hover', recommendation: 'close', reason: 'Intended behaviour', confidence: 'medium' });

  const openPr = new Bug(ISSUE.openPr, [LABEL.fix], '2026-03-12T08:00:00.000Z')
    .session('session-fix-3', '2026-03-12T08:01:00.000Z')
    .submit(PR.openPr, headSha(PR.openPr), '2026-03-12T12:00:00.000Z')
    .verify('pass', headSha(PR.openPr), '2026-03-12T12:30:00.000Z');
  openPr.event(
    {
      type: 'review-recorded',
      review: {
        rounds: [
          {
            prNumber: PR.openPr,
            headSha: headSha(PR.openPr),
            status: 'completed',
            requestedAt: '2026-03-12T12:31:00.000Z',
            completedAt: '2026-03-12T12:45:00.000Z',
            detail: null,
            findings: [
              {
                threadId: 'thread-1',
                path: 'src/export.ts',
                line: 42,
                body: 'The loop bound skips the final row when the page is full.',
                url: `https://github.com/acme/widgets/pull/${PR.openPr}#discussion_r1`,
                outdated: false,
              },
            ],
            correctionSentAt: null,
            blocker: null,
          },
        ],
        resolutions: [],
      },
    },
    '2026-03-12T12:45:00.000Z',
  );

  const waiting = new Bug(ISSUE.waitingForReply, [LABEL.triage], '2026-03-14T09:00:00.000Z')
    .session('session-triage-4', '2026-03-14T09:01:00.000Z')
    .event({ type: 'question-asked', question: { id: 'question-4', summary: 'Which timezone is the browser set to?' } }, '2026-03-14T10:00:00.000Z');

  const noProviderData = new Bug(ISSUE.noProviderData, [LABEL.triage], '2026-03-17T09:00:00.000Z');

  const engineer = new Bug(ISSUE.engineer, [LABEL.fix], '2026-03-15T09:00:00.000Z').session('session-fix-6', '2026-03-15T09:01:00.000Z');
  engineer.act({ name: 'engineer', actor: 'github:maria', context: 'Needs a design decision' }, '2026-03-15T12:00:00.000Z');
  engineer.labels = [LABEL.engineer];

  const verifying = new Bug(ISSUE.verifying, [LABEL.fix], '2026-03-16T09:00:00.000Z')
    .session('session-fix-8', '2026-03-16T09:01:00.000Z')
    .submit(PR.verifying, headSha(PR.verifying), '2026-03-16T13:00:00.000Z');

  return [merged, recommendClose, openPr, waiting, noProviderData, engineer, verifying].map((bug) => bug.record);
}

function seedGitHub(tracker: InMemoryTracker, setClock: (at: string) => void): void {
  const issues: [string, string[]][] = [
    ['Legend overlaps axis on narrow screens', [LABEL.fix]],
    ['Tooltip flickers on hover', [LABEL.triage]],
    ['CSV export drops the last row', [LABEL.fix]],
    ['Dates render in the wrong timezone', [LABEL.triage]],
    ['Crash when the dataset is empty', [LABEL.triage]],
    ['Zoom resets after refresh', [LABEL.engineer]],
    ['Keyboard focus is lost in the legend', [LABEL.fix]],
    ['Axis labels overlap at 200% zoom', [LABEL.fix]],
  ];
  for (const [title, labels] of issues) tracker.seedIssue({ title, labels });
  const pulls: [number, number][] = [
    [PR.merged, ISSUE.merged],
    [PR.openPr, ISSUE.openPr],
    [PR.verifying, ISSUE.verifying],
  ];
  for (const [number, issue] of pulls) {
    const pr = tracker.seedPullRequest({ title: `Fix #${issue}`, body: `Fixes #${issue}`, headSha: headSha(number), references: [issue] });
    if (pr.number !== number) throw new Error(`fixture PR numbered ${pr.number}, expected ${number}`);
  }
  setClock('2026-03-03T15:00:00.000Z');
  tracker.externalMerge(PR.merged, 'maria', mergeSha(PR.merged));
}

export interface DashboardWorld {
  settings: Settings;
  tracker: InMemoryTracker;
  offline: OfflineDevin;
  store: BugStore;
  dashboard: Dashboard;
  close(): Promise<void>;
}

/**
 * The sanitized fixture world behind the committed API fixtures: GitHub (`InMemoryTracker`), Devin
 * (`DevinClient` over `OfflineDevin`), a `BugStore` on disk and a fixed clock. No real credentials.
 */
export async function fixtureWorld(env: Env = FIXTURE_ENV): Promise<DashboardWorld> {
  let tick = Date.parse('2026-03-01T00:00:00.000Z');
  const clock = (): string => new Date((tick += 60_000)).toISOString();
  const setClock = (at: string): void => {
    tick = Date.parse(at) - 60_000;
  };
  const settings = loadSettings(env);
  const tracker = new InMemoryTracker({ now: clock });
  seedGitHub(tracker, setClock);
  const offline = new OfflineDevin({ apiKey: API_KEY, orgId: ORG_ID, now: () => NOW });
  const devin = new DevinClient({ apiKey: API_KEY, orgId: ORG_ID, maxAcuPerSession: 5, reviewEnabled: true, fetch: offline.fetch });
  const dir = await mkdtemp(join(tmpdir(), 'bug-smasher-dashboard-'));
  const store = await BugStore.open(join(dir, 'bugs.json'));
  for (const record of records()) await store.update(record.key, () => record);
  const dashboard = new Dashboard({ settings, now: () => NOW });
  dashboard.connect({ store, tracker, devin, lastCycleAt: () => '2026-03-18T11:59:00.000Z' });
  return { settings, tracker, offline, store, dashboard, close: () => rm(dir, { recursive: true, force: true }) };
}

export interface Listening {
  baseUrl: string;
  close(): Promise<void>;
}

export async function listen(server: Server): Promise<Listening> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function serve(dashboard: Dashboard): Promise<Listening> {
  return listen(createApp({ staticDir: join(tmpdir(), 'bug-smasher-no-static'), dashboard }));
}

/** A raw HTTP request, so the `Host` header can be set (fetch always derives it from the URL). */
export function rawRequest(baseUrl: string, path: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; body: string }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: options.method ?? 'GET', headers: options.host === undefined ? {} : { host: options.host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
