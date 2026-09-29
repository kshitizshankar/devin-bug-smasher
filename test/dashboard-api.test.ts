import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import { isLoopbackHost, loadSettings } from '../src/config/settings.ts';
import { Dashboard } from '../src/dashboard/dashboard.ts';
import type { MetricsResponse, OverviewIssue, OverviewResponse, SettingsResponse } from '../src/dashboard/types.ts';
import { parseBugKey } from '../src/model/keys.ts';
import { attention, GATES, OVERVIEW_GROUPS, presentBug, STATUS_CODES, type Gate, type OverviewGroup, type StatusCode } from '../src/model/presentation.ts';
import { isLocalHostHeader } from '../src/server/app.ts';
import { toGitHubFacts } from '../src/tracker/common.ts';
import { API_KEY, FIXTURE_ENV, fixtureWorld, GITHUB_TOKEN, ISSUE, PR, rawRequest, serve, type DashboardWorld, type Listening } from './helpers/dashboard.ts';
import { Harness } from './helpers/orchestrator.ts';
import { startService } from './helpers/service.ts';

const ENDPOINTS = ['/api/overview', '/api/metrics', '/api/settings'] as const;
const FIXTURES = new URL('./fixtures/api/', import.meta.url);
const HEAD = '1'.repeat(40);

async function getJson<T>(baseUrl: string, path: string): Promise<{ status: number; text: string; body: T }> {
  const response = await fetch(new URL(path, baseUrl));
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/, path);
  return { status: response.status, text, body: JSON.parse(text) as T };
}

function issueOf(response: OverviewResponse, number: number): OverviewIssue {
  const issue = response.overview?.issues.find((item) => item.number === number);
  assert.ok(issue, `issue #${number} in the overview`);
  return issue;
}

async function world(t: TestContext, env = FIXTURE_ENV): Promise<{ w: DashboardWorld; http: Listening }> {
  const w = await fixtureWorld(env);
  await w.dashboard.refresh();
  const http = await serve(w.dashboard);
  t.after(async () => {
    await http.close();
    await w.close();
  });
  return { w, http };
}

describe('dashboard API: fixture responses', () => {
  let w: DashboardWorld;
  let http: Listening;

  before(async () => {
    w = await fixtureWorld();
    await w.dashboard.refresh();
    http = await serve(w.dashboard);
  });

  after(async () => {
    await http?.close();
    await w?.close();
  });

  for (const path of ENDPOINTS) {
    it(`GET ${path} matches the sanitized fixture`, async () => {
      const { status, text, body } = await getJson<unknown>(http.baseUrl, path);
      assert.equal(status, 200);
      const file = new URL(`${path.slice('/api/'.length)}.json`, FIXTURES);
      if (process.env.UPDATE_API_FIXTURES === '1') await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
      const fixture = await readFile(file, 'utf8');
      assert.deepEqual(body, JSON.parse(fixture));
      for (const secret of [GITHUB_TOKEN, API_KEY]) {
        assert.ok(!text.includes(secret), `${path} response contains no secret`);
        assert.ok(!fixture.includes(secret), `${path} fixture contains no secret`);
      }
    });
  }

  it('reports the last refresh time on every endpoint', async () => {
    for (const path of ENDPOINTS) {
      const { body } = await getJson<{ refresh: OverviewResponse['refresh'] }>(http.baseUrl, path);
      assert.deepEqual(body.refresh, { state: 'current', lastRefreshAt: '2026-03-18T12:00:00.000Z', lastAttemptAt: '2026-03-18T12:00:00.000Z', problems: [] }, path);
    }
  });

  it('returns compact issue records, merged ones included, with the issue URL and the actual PR URL', async () => {
    const { body } = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    assert.deepEqual(body.overview?.issues.map((issue) => issue.number), [1, 2, 3, 4, 5, 6, 7, 8]);
    const merged = issueOf(body, ISSUE.merged);
    assert.equal(merged.status, 'merged');
    assert.equal(merged.title, 'Legend overlaps axis on narrow screens');
    assert.equal(merged.url, 'https://github.com/acme/widgets/issues/1');
    assert.deepEqual(merged.pullRequest, { number: PR.merged, url: `https://github.com/acme/widgets/pull/${PR.merged}`, state: 'merged' });
    assert.deepEqual(merged.timestamp, { kind: 'merged', at: '2026-03-03T15:00:00.000Z' });
    for (const issue of body.overview?.issues ?? []) {
      assert.ok(issue.title.length > 0 && issue.attention.text.length > 0 && issue.timestamp.at.length > 0, `#${issue.number} is complete`);
    }
  });

  it('derives status, groups, gates, counts and next-action text with the shared presentation', async () => {
    const { body } = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    const overview = body.overview;
    assert.ok(overview);
    const records = new Map(w.store.list().map((record) => [parseBugKey(record.key)?.number, record]));
    const groups = Object.fromEntries(OVERVIEW_GROUPS.map((group) => [group, 0])) as Record<OverviewGroup, number>;
    const statuses = Object.fromEntries(STATUS_CODES.map((code) => [code, 0])) as Record<StatusCode, number>;
    const gates = Object.fromEntries(GATES.map((gate) => [gate, 0])) as Record<Gate, number>;
    for (const item of overview.issues) {
      const record = records.get(item.number);
      const issue = await w.tracker.getIssue(item.number);
      const pr = record?.fix == null ? null : await w.tracker.getPullRequest(record.fix.prNumber);
      const expected = presentBug(record, toGitHubFacts(w.tracker.repo, issue, pr), w.settings.labels);
      assert.deepEqual(
        { status: item.status, statusLabel: item.statusLabel, group: item.group, attention: item.attention, recommendation: item.recommendation },
        { status: expected.status, statusLabel: expected.statusLabel, group: expected.group, attention: attention(expected), recommendation: expected.history.recommendation },
        `#${item.number}`,
      );
      groups[expected.group] += 1;
      statuses[expected.status] += 1;
      const gate = attention(expected).gate;
      if (gate !== null) gates[gate] += 1;
    }
    assert.deepEqual(overview.counts, { issues: 8, groups, statuses, gates });
  });

  it('shows a Devin close recommendation without a decision as awaiting a decision, not closed', async () => {
    const { body } = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    const issue = issueOf(body, ISSUE.recommendClose);
    assert.equal(issue.recommendation, 'close');
    assert.equal(issue.status, 'needs-decision');
    assert.equal(issue.issueState, 'open');
    assert.equal(issue.attention.gate, 'decision');
    assert.match(issue.attention.text, /recommends closing the issue; this is not a decision/);
    assert.equal(body.overview?.counts.statuses.closed, 0);
  });

  it('never counts an open pull request as merged', async () => {
    const { body } = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    for (const number of [ISSUE.openPr, ISSUE.verifying]) {
      const issue = issueOf(body, number);
      assert.equal(issue.pullRequest?.state, 'open');
      assert.notEqual(issue.status, 'merged');
      assert.notEqual(issue.group, 'Merged');
    }
    assert.equal(body.overview?.counts.statuses.merged, 1);
    assert.equal(body.overview?.counts.groups.Merged, 1);
  });

  it('includes verification, session and review links only when the records supply them', async () => {
    const { body } = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    const withReview = issueOf(body, ISSUE.openPr);
    assert.deepEqual(withReview.session, { id: 'session-fix-3', url: 'https://app.devin.ai/sessions/session-fix-3', state: 'starting' });
    assert.equal(withReview.verification?.result, 'pass');
    assert.equal(withReview.verification?.currentHeadVerified, true);
    assert.deepEqual(withReview.review?.findings, [{ url: `https://github.com/acme/widgets/pull/${PR.openPr}#discussion_r1`, path: 'src/export.ts', line: 42 }]);
    for (const number of [ISSUE.noProviderData, ISSUE.notEnrolled]) {
      const issue = issueOf(body, number);
      for (const field of ['pullRequest', 'session', 'verification', 'review']) assert.ok(!(field in issue), `#${number} has no ${field}`);
    }
    for (const number of [ISSUE.recommendClose, ISSUE.waitingForReply, ISSUE.engineer]) {
      assert.ok(!('pullRequest' in issueOf(body, number)), `PR-less #${number} has no PR URL`);
      assert.ok(!('review' in issueOf(body, number)), `#${number} has no review`);
    }
  });

  it('returns each measure with its window, denominator, evidence and source from the shared metrics report', async () => {
    const { body } = await getJson<MetricsResponse>(http.baseUrl, '/api/metrics');
    const metrics = body.metrics;
    assert.ok(metrics?.live);
    assert.equal(metrics.target, 'acme/widgets');
    const figures = [metrics.live.keys.fixThroughput.figure, metrics.live.keys.timeToFixMedian.figure, metrics.live.keys.firstTimePass.figure, metrics.live.keys.escapedFixes.figure, ...metrics.live.flow.openByStage];
    for (const figure of figures) {
      assert.ok(figure.window.end.length > 0 && figure.window.label.length > 0, `${figure.id} window`);
      assert.ok(figure.source.length > 0, `${figure.id} source`);
      assert.ok('denominator' in figure && 'samples' in figure && 'numerator' in figure, `${figure.id} evidence`);
    }
    const overview = (await getJson<OverviewResponse>(http.baseUrl, '/api/overview')).body.overview;
    assert.deepEqual(overview?.headline?.firstTimePass, metrics.live.keys.firstTimePass);
    assert.deepEqual(overview?.headline?.fixThroughput, metrics.live.keys.fixThroughput);
  });
});

describe('dashboard API: settings and credentials', () => {
  it('serves every endpoint with no GitHub or Devin credentials configured', async (t) => {
    const { http } = await world(t, { GITHUB_REPO: 'acme/widgets', STATIC_DIR: '/srv/web', VERIFY_WORK_DIR: '/srv/verify' });
    const overview = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    const metrics = await getJson<MetricsResponse>(http.baseUrl, '/api/metrics');
    const settings = await getJson<SettingsResponse>(http.baseUrl, '/api/settings');
    assert.deepEqual([overview.status, metrics.status, settings.status], [200, 200, 200]);
    assert.equal(overview.body.overview?.issues.length, 8);
    assert.ok(metrics.body.metrics?.live);
    assert.equal(settings.body.settings.github.tokenConfigured, false);
    assert.equal(settings.body.settings.devin.apiKeyConfigured, false);
  });

  it('exposes effective settings with a GitHub token and Devin API key configured, without either value', async (t) => {
    const { w, http } = await world(t);
    const { text, body } = await getJson<SettingsResponse>(http.baseUrl, '/api/settings');
    assert.equal(body.settings.github.tokenConfigured, true);
    assert.equal(body.settings.devin.apiKeyConfigured, true);
    assert.equal(body.settings.github.repo, 'acme/widgets');
    assert.equal(body.settings.devin.orgId, w.settings.devin.orgId);
    assert.ok(!text.includes(GITHUB_TOKEN) && !text.includes(API_KEY));
    assert.ok(!('token' in body.settings.github) && !('apiKey' in body.settings.devin));
  });
});

describe('dashboard API: refresh from GitHub', () => {
  it('reflects GitHub replies, label changes, issue closure and PR merges after orchestration refreshes', async (t) => {
    const h = await Harness.create();
    t.after(() => h.close());
    const dashboard = new Dashboard({ settings: h.settings, now: h.clock });
    dashboard.connect({ store: h.store, tracker: h.tracker, devin: h.client, lastCycleAt: () => h.orchestrator.lastCycleAt });
    const cycle = async (count = 1): Promise<OverviewResponse> => {
      await h.cycle(count);
      await dashboard.refresh();
      return dashboard.overview();
    };

    const asking = h.tracker.seedIssue({ title: 'Chart blank in Safari', labels: ['needs-triage'] });
    assert.equal(issueOf(await cycle(2), asking.number).status, 'investigating');
    h.asks(h.sessionId(asking.key), 'Which Safari version?');
    let item = issueOf(await cycle(), asking.number);
    assert.equal(item.status, 'waiting-for-reply');
    assert.equal(item.attention.gate, 'reply');

    h.tracker.externalComment(asking.number, 'reporter', 'Safari 17.4');
    item = issueOf(await cycle(2), asking.number);
    assert.equal(item.status, 'investigating', 'the GitHub reply is reflected');

    h.tracker.externalLabel(asking.number, 'needs-engineer', 'add', 'maria');
    item = issueOf(await cycle(), asking.number);
    assert.equal(item.status, 'needs-engineer', 'the GitHub label change is reflected');

    const closing = h.tracker.seedIssue({ title: 'Duplicate report', labels: ['needs-triage'] });
    await cycle();
    h.tracker.externalCloseIssue(closing.number, 'maria');
    item = issueOf(await cycle(), closing.number);
    assert.equal(item.status, 'closed', 'the GitHub closure is reflected');
    assert.equal(item.issueState, 'closed');

    const fixing = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['bug-smasher'] });
    await cycle(2);
    const pr = h.tracker.seedPullRequest({ title: 'Fix legend', body: `Fixes #${fixing.number}`, headSha: HEAD, references: [fixing.number] });
    h.opensPr(h.sessionId(fixing.key), pr.url);
    let overview = await cycle();
    item = issueOf(overview, fixing.number);
    assert.equal(item.pullRequest?.state, 'open');
    assert.notEqual(item.status, 'merged');
    assert.equal(overview.overview?.counts.statuses.merged, 0);

    h.tracker.externalMerge(pr.number, 'maria');
    await dashboard.refresh();
    overview = dashboard.overview();
    item = issueOf(overview, fixing.number);
    assert.equal(item.status, 'merged', 'GitHub is authoritative for the merge before the orchestrator records it');
    assert.equal(item.pullRequest?.state, 'merged');
    assert.equal(overview.overview?.counts.statuses.merged, 1);
    assert.equal(issueOf(await cycle(), fixing.number).status, 'merged');
  });
});

describe('dashboard API: provider outages', () => {
  it('keeps the last snapshot as stale with its refresh time when GitHub or Devin is unreachable', async (t) => {
    const { w, http } = await world(t);
    const before = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');

    w.tracker.failNext('listOpenIssues', 'network');
    await w.dashboard.refresh();
    for (const path of ENDPOINTS) {
      const { body } = await getJson<{ refresh: OverviewResponse['refresh'] }>(http.baseUrl, path);
      assert.equal(body.refresh.state, 'stale', path);
      assert.equal(body.refresh.lastRefreshAt, '2026-03-18T12:00:00.000Z', path);
      assert.deepEqual(body.refresh.problems.map((problem) => problem.source), ['github'], path);
    }
    const stale = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    assert.deepEqual(stale.body.overview, before.body.overview, 'the previous snapshot is served unchanged');
    assert.ok((await getJson<MetricsResponse>(http.baseUrl, '/api/metrics')).body.metrics !== null);

    await w.dashboard.refresh();
    assert.equal(w.dashboard.overview().refresh.state, 'current', 'a successful refresh is current again');

    w.offline.failNext({ network: 'reset' });
    await w.dashboard.refresh();
    const devinDown = w.dashboard.overview();
    assert.equal(devinDown.refresh.state, 'stale');
    assert.deepEqual(devinDown.refresh.problems.map((problem) => problem.source), ['devin']);
    assert.equal(devinDown.overview?.issues.length, 8);
  });

  it('reports unavailable, not zero records or counts, when no snapshot was ever read', async (t) => {
    const w = await fixtureWorld();
    const http = await serve(w.dashboard);
    t.after(async () => {
      await http.close();
      await w.close();
    });
    const initial = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.refresh.state, 'unavailable');
    assert.equal(initial.body.overview, null);

    w.tracker.failNext('listOpenIssues', 'network');
    await w.dashboard.refresh();
    const overview = await getJson<OverviewResponse>(http.baseUrl, '/api/overview');
    const metrics = await getJson<MetricsResponse>(http.baseUrl, '/api/metrics');
    for (const body of [overview.body, metrics.body]) {
      assert.equal(body.refresh.state, 'unavailable');
      assert.equal(body.refresh.lastRefreshAt, null);
      assert.equal(body.refresh.lastAttemptAt, '2026-03-18T12:00:00.000Z');
      assert.equal(body.refresh.problems[0]?.source, 'github');
    }
    assert.equal(overview.body.overview, null);
    assert.equal(metrics.body.metrics, null);
    const settings = await getJson<SettingsResponse>(http.baseUrl, '/api/settings');
    assert.equal(settings.body.refresh.state, 'unavailable');
    assert.equal(settings.body.settings.github.repo, 'acme/widgets', 'configuration is local and still served');
  });

  it('marks the snapshot stale when providers are disconnected', async (t) => {
    const { w } = await world(t);
    w.dashboard.disconnect('Workflow polling failed to start: store unreadable');
    const response = w.dashboard.overview();
    assert.equal(response.refresh.state, 'stale');
    assert.deepEqual(response.refresh.problems, [{ source: 'workflow', reason: 'Workflow polling failed to start: store unreadable' }]);
  });
});

describe('dashboard API: read-only and localhost only', () => {
  it('rejects POST, PUT, PATCH and DELETE on every API path without local or provider changes', async (t) => {
    const { w, http } = await world(t);
    const storeBefore = await readFile(w.store.path, 'utf8');
    const githubState = async (): Promise<string> => {
      const state = [];
      for (let number = 1; number <= 11; number += 1) {
        const pr = Object.values(PR).includes(number as never);
        state.push(pr ? await w.tracker.getPullRequest(number) : [await w.tracker.getIssue(number), await w.tracker.listComments(number), await w.tracker.listIssueEvents(number)]);
      }
      return JSON.stringify(state);
    };
    const githubBefore = await githubState();
    const devinRequests = w.offline.requests.length;
    const overviewBefore = w.dashboard.overview();

    for (const path of [...ENDPOINTS, '/api/health', '/api', '/api/bugs/acme/widgets%231/reply', '/api/unknown']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(new URL(path, http.baseUrl), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'merge' }) });
        assert.equal(response.status, 405, `${method} ${path}`);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
        assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
      }
    }

    assert.equal(await readFile(w.store.path, 'utf8'), storeBefore, 'the store is unchanged');
    assert.equal(await githubState(), githubBefore, 'GitHub is unchanged');
    assert.equal(w.offline.requests.length, devinRequests, 'Devin was not called');
    assert.deepEqual(w.dashboard.overview(), overviewBefore, 'the snapshot is unchanged');
  });

  it('accepts only local Host headers', async (t) => {
    const { http } = await world(t);
    for (const host of ['evil.example', 'evil.example:80', 'localhost.evil.example', '127.0.0.1.nip.io', '10.0.0.5:8080', '[::2]:8080']) {
      for (const path of ['/api/health', '/api/overview', '/']) {
        const response = await rawRequest(http.baseUrl, path, { host });
        assert.equal(response.status, 403, `${host} ${path}`);
      }
    }
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:8080', '[::1]:8080']) {
      assert.equal((await rawRequest(http.baseUrl, '/api/overview', { host })).status, 200, host);
    }
    assert.equal(isLocalHostHeader(undefined), false);
  });

  it('accepts only loopback bind addresses', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1']) assert.ok(isLoopbackHost(host), host);
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '127.0.0.256', '']) assert.ok(!isLoopbackHost(host), host);
    assert.throws(() => loadSettings({ HOST: '0.0.0.0' }), /HOST must be a loopback address/);
  });
});

describe('dashboard API: running service', () => {
  it('serves health and the new endpoints on localhost, unavailable until live polling reads providers', async () => {
    const service = await startService({ GITHUB_TOKEN, DEVIN_API_KEY: API_KEY, GITHUB_REPO: 'acme/widgets', DEVIN_ORG_ID: 'org-test', CHECK_COMMAND: '' });
    try {
      assert.match(service.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await getJson<unknown>(service.baseUrl, '/api/health');
      assert.deepEqual(health.body, { status: 'ok', service: 'bug-smasher', stage: 'scaffold' });
      const overview = await getJson<OverviewResponse>(service.baseUrl, '/api/overview');
      assert.equal(overview.status, 200);
      assert.equal(overview.body.refresh.state, 'unavailable');
      assert.equal(overview.body.overview, null);
      assert.match(overview.body.refresh.problems[0]?.reason ?? '', /Workflow polling is off until live settings are complete/);
      const metrics = await getJson<MetricsResponse>(service.baseUrl, '/api/metrics');
      assert.equal(metrics.body.metrics, null);
      const settings = await getJson<SettingsResponse>(service.baseUrl, '/api/settings');
      assert.equal(settings.body.settings.github.tokenConfigured, true);
      assert.equal(settings.body.settings.devin.apiKeyConfigured, true);
      for (const response of [overview, metrics, settings]) assert.ok(!response.text.includes(GITHUB_TOKEN) && !response.text.includes(API_KEY));
      assert.equal((await fetch(new URL('/api/overview', service.baseUrl), { method: 'POST' })).status, 405);
      assert.equal((await rawRequest(service.baseUrl, '/api/health', { host: 'evil.example' })).status, 403);
    } finally {
      await service.stop();
    }
  });

  it('refuses to start on a non-loopback HOST', async () => {
    await assert.rejects(startService({ HOST: '0.0.0.0' }), /HOST must be a loopback address/);
  });
});
