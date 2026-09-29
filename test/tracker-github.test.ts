import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { SettingsError, loadSettings } from '../src/config/settings.ts';
import { closesIssue, toGitHubFacts } from '../src/tracker/common.ts';
import { GITHUB_API_VERSION, GitHubTracker, githubTrackerFromSettings } from '../src/tracker/github.ts';
import { FakeGitHub } from './helpers/fake-github.ts';
import { HEAD_1, HEAD_2, rejectsWith, trackerContract } from './helpers/tracker-contract.ts';

const TOKEN = 'ghp_fakeTokenValue0123456789';

async function withFake(
  run: (fake: FakeGitHub, tracker: GitHubTracker) => Promise<void>,
  options: { perPage?: number; maxPages?: number; timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
  const fake = await FakeGitHub.start({ token: TOKEN });
  try {
    await run(fake, new GitHubTracker({ repo: fake.repo, token: TOKEN, baseUrl: fake.baseUrl, ...options }));
  } finally {
    await fake.close();
  }
}

trackerContract('GitHubTracker (fake GitHub REST)', async () => {
  const fake = await FakeGitHub.start({ token: TOKEN });
  // Two items per page so every listing in the contract crosses page boundaries.
  const tracker = new GitHubTracker({ repo: fake.repo, token: TOKEN, baseUrl: fake.baseUrl, perPage: 2 });
  return { tracker, sim: fake, serviceLogin: fake.actor.login, close: () => fake.close() };
});

describe('GitHubTracker requests', () => {
  it('sends the REST headers and follows Link pagination to the last page', async () => {
    await withFake(
      async (fake, tracker) => {
        for (let index = 0; index < 5; index += 1) fake.seedIssue({ title: `bug ${index}`, labels: ['needs-triage'] });
        const issues = await tracker.listOpenIssues(['needs-triage']);
        assert.equal(issues.length, 5);
        const listing = fake.requestsFor('listOpenIssues');
        assert.deepEqual(
          listing.map((request) => request.query.get('page')),
          [null, '2', '3'],
        );
        const first = listing[0];
        assert.equal(first?.query.get('state'), 'open');
        assert.equal(first?.query.get('labels'), 'needs-triage');
        assert.equal(first?.query.get('per_page'), '2');
        assert.equal(first?.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(first?.headers.accept, 'application/vnd.github+json');
        assert.equal(first?.headers['x-github-api-version'], GITHUB_API_VERSION);
        assert.ok(first?.headers['user-agent']);
      },
      { perPage: 2 },
    );
  });

  it('deduplicates items that shift between pages while paging', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug' });
      const ids = ['one', 'two', 'three'].map((body) => fake.externalComment(issue.number, 'reporter', body).id);
      const json = (id: string, body: string): object => ({
        id: Number(id),
        user: { login: 'reporter', id: 1, type: 'User' },
        body,
        html_url: `https://github.com/acme/widgets/issues/${issue.number}#issuecomment-${id}`,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        author_association: 'NONE',
      });
      // A comment was deleted between page requests, so "two" slides onto page 2 and is seen twice.
      fake.respondOnce((request) => request.route.endsWith('/comments') && request.query.get('page') === '2', {
        status: 200,
        body: [json(ids[1] ?? '', 'two'), json(ids[2] ?? '', 'three')],
      });
      const comments = await tracker.listComments(issue.number);
      assert.deepEqual(
        comments.map((comment) => comment.id),
        ids,
      );
    }, { perPage: 2 });
  });

  it('refuses to return partial listings when the page limit is exceeded', async () => {
    await withFake(
      async (fake, tracker) => {
        for (let index = 0; index < 5; index += 1) fake.seedIssue({ title: `bug ${index}`, labels: ['needs-triage'] });
        const error = await rejectsWith(tracker.listOpenIssues(['needs-triage']), 'incomplete');
        assert.equal(error.retryable, false);
      },
      { perPage: 2, maxPages: 2 },
    );
  });

  it('does not follow pagination links to another origin or send the token there', async () => {
    let foreignRequests = 0;
    const foreign = createServer((_req, res) => {
      foreignRequests += 1;
      res.end('[]');
    });
    foreign.listen(0, '127.0.0.1');
    await once(foreign, 'listening');
    const foreignUrl = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
    try {
      await withFake(async (fake, tracker) => {
        const issue = fake.seedIssue({ title: 'bug' });
        fake.respondOnce((request) => request.route.endsWith('/events'), {
          status: 200,
          body: [],
          headers: { link: `<${foreignUrl}/steal?page=2>; rel="next"` },
        });
        await rejectsWith(tracker.listIssueEvents(issue.number), 'invalid-response');
      });
    } finally {
      foreign.close();
    }
    assert.equal(foreignRequests, 0);
  });

  it('follows same-origin redirects but refuses a redirect to another origin', async () => {
    let foreignRequests = 0;
    const foreign = createServer((_req, res) => {
      foreignRequests += 1;
      res.end('[]');
    });
    foreign.listen(0, '127.0.0.1');
    await once(foreign, 'listening');
    const foreignUrl = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
    try {
      await withFake(async (fake, tracker) => {
        const issue = fake.seedIssue({ title: 'bug' });
        const route = `/repos/${fake.repo.owner}/${fake.repo.name}/issues/${issue.number}`;
        fake.respondOnce((request) => request.route === `issues/${issue.number}`, {
          status: 301,
          headers: { location: `${fake.baseUrl}${route}?renamed=1` },
        });
        assert.equal((await tracker.getIssue(issue.number)).number, issue.number);

        fake.respondOnce((request) => request.route.endsWith('/events'), {
          status: 302,
          headers: { location: `${foreignUrl}/steal` },
        });
        await rejectsWith(tracker.listIssueEvents(issue.number), 'invalid-response');
      });
    } finally {
      foreign.close();
    }
    assert.equal(foreignRequests, 0);
  });

  it('posts a keyed comment once when the same key is posted concurrently', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug' });
      const [first, second] = await Promise.all([
        tracker.postComment(issue.number, 'question', { key: 'q1' }),
        tracker.postComment(issue.number, 'question', { key: 'q1' }),
      ]);
      assert.equal(first.id, second.id);
      assert.equal(fake.requestsFor('postComment').filter((request) => request.method === 'POST').length, 1);
    });
  });

  it('filters timeline references to pull requests in the same repository', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug' });
      const pr = fake.seedPullRequest({ title: 'fix', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
      const reference = (repositoryUrl: string, number: number, pullRequest: boolean): object => ({
        event: 'cross-referenced',
        created_at: '2026-01-01T00:00:00Z',
        source: {
          type: 'issue',
          issue: { number, repository_url: repositoryUrl, ...(pullRequest ? { pull_request: { url: 'x' } } : {}) },
        },
      });
      fake.respondOnce((request) => request.route.endsWith('/timeline'), {
        status: 200,
        body: [
          reference(`${fake.baseUrl}/repos/acme/widgets`, pr.number, true),
          reference(`${fake.baseUrl}/repos/other/widgets`, pr.number, true),
          reference(`${fake.baseUrl}/repos/acme/widgets-fork`, pr.number, true),
          reference(`${fake.baseUrl}/repos/acme/widgets`, 77, false),
          { event: 'labeled', label: { name: 'x' } },
          reference(`${fake.baseUrl}/repos/acme/widgets`, pr.number, true),
        ],
      });
      const linked = await tracker.findLinkedPullRequests(issue.number);
      assert.deepEqual(
        linked.map((link) => [link.pullRequest.number, link.relation]),
        [[pr.number, 'closing']],
      );
      assert.equal(fake.requestsFor('getPullRequest').length, 1, 'only same-repository PRs are read');
    });
  });

  it('passes the expected head SHA to the merge endpoint and maps a lost race to head-mismatch', async () => {
    await withFake(async (fake, tracker) => {
      const pr = fake.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
      fake.respondOnce((request) => request.route.endsWith('/merge'), {
        status: 409,
        body: { message: 'Head branch was modified. Review and try the merge again.' },
      });
      await rejectsWith(tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_1 }), 'head-mismatch');
      await tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_1, method: 'squash', commitTitle: 'Fix (#2)' });
      const bodies = fake.requestsFor('mergePullRequest').map((request) => request.body);
      assert.deepEqual(bodies, [{ sha: HEAD_1 }, { sha: HEAD_1, merge_method: 'squash', commit_title: 'Fix (#2)' }]);

      const before = fake.requestsFor('mergePullRequest').length;
      const moved = fake.seedPullRequest({ title: 'moved', headSha: HEAD_1 });
      fake.pushHead(moved.number, HEAD_2);
      await rejectsWith(tracker.mergePullRequest(moved.number, { expectedHeadSha: HEAD_1 }), 'head-mismatch');
      assert.equal(fake.requestsFor('mergePullRequest').length, before, 'no merge request is sent for a moved head');
    });
  });

  it('treats a missing label as a no-op but a missing issue as not-found', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      assert.deepEqual(await tracker.removeLabel(issue.number, 'needs triage/α'), ['bug-smasher']);
      assert.ok(fake.requestsFor('removeLabel')[0]?.path.endsWith('/labels/needs%20triage%2F%CE%B1'), 'the label is one encoded path segment');
      await rejectsWith(tracker.removeLabel(999, 'bug-smasher'), 'not-found');
    });
  });

  it('keeps the destination label when removing the source label fails', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      fake.failNext('removeLabel', 'server-error');
      const error = await rejectsWith(tracker.moveLabel(issue.number, { from: 'bug-smasher', to: 'needs-engineer' }), 'server-error');
      assert.equal(error.ambiguous, true);
      assert.deepEqual((await tracker.getIssue(issue.number)).labels, ['bug-smasher', 'needs-engineer']);
      const order = fake.requests.filter((request) => request.method !== 'GET').map((request) => request.method);
      assert.deepEqual(order, ['POST', 'DELETE']);
    });
  });

  it('never exposes the test-merge SHA of an open PR', async () => {
    await withFake(async (fake, tracker) => {
      const pr = fake.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
      const read = await tracker.getPullRequest(pr.number);
      assert.equal(read.mergeCommitSha, null);
      assert.equal(read.state, 'open');
    });
  });
});

describe('GitHubTracker failures', () => {
  it('computes the wait from the primary rate limit reset and keeps rate-limit metadata', async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    await withFake(
      async (fake, tracker) => {
        fake.respondOnce(() => true, {
          status: 403,
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(now / 1000 + 90),
            'x-ratelimit-resource': 'core',
            'x-github-request-id': 'ABCD:1234',
          },
          body: { message: 'API rate limit exceeded for user ID 1.' },
        });
        const error = await rejectsWith(tracker.getIssue(1), 'rate-limited');
        assert.equal(error.retryAfterSeconds, 90);
        assert.equal(error.status, 403);
        assert.equal(error.requestId, 'ABCD:1234');
        assert.deepEqual(error.rateLimit, { limit: 5000, remaining: 0, resetAt: '2026-01-01T12:01:30.000Z', resource: 'core' });
      },
      { now: () => now },
    );
  });

  it('honours retry-after for secondary limits and 429 responses', async () => {
    await withFake(async (fake, tracker) => {
      fake.respondOnce(() => true, {
        status: 403,
        headers: { 'retry-after': '30' },
        body: { message: 'You have exceeded a secondary rate limit.' },
      });
      assert.equal((await rejectsWith(tracker.getIssue(1), 'rate-limited')).retryAfterSeconds, 30);
      fake.respondOnce(() => true, { status: 429, body: { message: 'Too Many Requests' } });
      assert.equal((await rejectsWith(tracker.getIssue(1), 'rate-limited')).retryAfterSeconds, 60);
      fake.respondOnce(() => true, { status: 403, body: { message: 'Resource not accessible by integration' } });
      const forbidden = await rejectsWith(tracker.getIssue(1), 'forbidden');
      assert.equal(forbidden.retryable, false);
    });
  });

  it('maps authentication, validation, server, network, timeout and malformed responses', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug' });
      const wrongToken = new GitHubTracker({ repo: fake.repo, token: 'ghp_wrongTokenValue999999', baseUrl: fake.baseUrl });
      await rejectsWith(wrongToken.getIssue(issue.number), 'unauthorized');

      fake.respondOnce(() => true, {
        status: 422,
        body: { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', message: 'title is too long' }] },
      });
      assert.match((await rejectsWith(tracker.createIssue({ title: 'x', body: '' }), 'validation')).message, /title is too long/);

      fake.respondOnce(() => true, { status: 200, body: 'not json' });
      await rejectsWith(tracker.getIssue(issue.number), 'invalid-response');
      fake.respondOnce(() => true, { status: 200, body: { number: issue.number } });
      await rejectsWith(tracker.getIssue(issue.number), 'invalid-response');

      fake.respondOnce(() => true, { status: 503, body: { message: 'Service Unavailable' } });
      const unavailable = await rejectsWith(tracker.addLabels(issue.number, ['x']), 'server-error');
      assert.equal(unavailable.ambiguous, true);
    });

    const closed = await FakeGitHub.start();
    const url = closed.baseUrl;
    await closed.close();
    const offline = new GitHubTracker({ repo: { owner: 'acme', name: 'widgets' }, token: TOKEN, baseUrl: url });
    const network = await rejectsWith(offline.postComment(1, 'hello'), 'network');
    assert.equal(network.ambiguous, true);
    assert.equal(network.retryable, true);
    assert.equal((await rejectsWith(offline.getIssue(1), 'network')).ambiguous, false);

    const slow = createServer(() => {});
    slow.listen(0, '127.0.0.1');
    await once(slow, 'listening');
    try {
      const timing = new GitHubTracker({
        repo: { owner: 'acme', name: 'widgets' },
        token: TOKEN,
        baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
        timeoutMs: 50,
      });
      const timeout = await rejectsWith(timing.getIssue(1), 'timeout');
      assert.equal(timeout.retryable, true);
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  it('redacts the token and token-like strings from errors, serialization and inspection', async () => {
    await withFake(async (fake, tracker) => {
      fake.respondOnce(() => true, (request) => ({
        status: 500,
        body: { message: `upstream echoed ${String(request.headers.authorization)} and ghp_otherLeakedToken1234 and token abcdefghijk123` },
      }));
      const error = await rejectsWith(tracker.getIssue(1), 'server-error');
      for (const text of [error.message, JSON.stringify(error), inspect(error), String(error.stack)]) {
        assert.ok(!text.includes(TOKEN), text);
        assert.ok(!text.includes('ghp_otherLeakedToken1234'), text);
        assert.ok(!text.includes('abcdefghijk123'), text);
      }
      assert.match(error.message, /\[redacted\]/);
      assert.ok(!inspect(tracker).includes(TOKEN), 'the tracker does not expose its token when inspected');
      assert.ok(!JSON.stringify(tracker).includes(TOKEN));
    });
  });

  it('reports a diff GitHub refuses to render as incomplete', async () => {
    await withFake(async (fake, tracker) => {
      const pr = fake.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
      fake.respondOnce((request) => request.route === `pulls/${pr.number}`, {
        status: 422,
        body: { message: 'Server Error: Sorry, this diff is taking too long to generate.' },
      });
      const diff = await tracker.getPullRequestDiff(pr.number);
      assert.equal(diff.complete, false);
      assert.equal(fake.requestsFor('getPullRequestDiff')[0]?.headers.accept, 'application/vnd.github.diff');
    });
  });
});

describe('tracker helpers', () => {
  const repo = { owner: 'acme', name: 'widgets' };

  it('matches closing keywords only for this exact issue', () => {
    for (const text of ['Fixes #12', 'closes: #12.', 'Resolved acme/widgets#12', 'fix https://github.com/acme/widgets/issues/12', 'CLOSE #12\n']) {
      assert.equal(closesIssue(text, repo, 12), true, text);
    }
    for (const text of ['Fixes #123', 'Fixes #1', 'Refs #12', 'fixes other/widgets#12', 'fixes acme/widgets-old#12', 'prefixes #12', 'Fixes #12a', 'issue 12 fixed', 'Fixes https://github.com/acme/widgets/pull/12']) {
      assert.equal(closesIssue(text, repo, 12), false, text);
    }
  });

  it('builds the model GitHub facts from tracker reads', async () => {
    await withFake(async (fake, tracker) => {
      const issue = fake.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      const pr = fake.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
      const facts = toGitHubFacts(tracker.repo, await tracker.getIssue(issue.number), await tracker.getPullRequest(pr.number));
      assert.deepEqual(facts, {
        issue: { owner: 'acme', repo: 'widgets', number: issue.number, state: 'open', labels: ['bug-smasher'] },
        pullRequest: { number: pr.number, state: 'open', headSha: HEAD_1 },
      });
    });
  });

  it('builds the live tracker from settings and requires repo and token without leaking values', () => {
    const settings = loadSettings({ GITHUB_REPO: 'acme/widgets', GITHUB_TOKEN: TOKEN });
    assert.deepEqual(githubTrackerFromSettings(settings).repo, repo);
    assert.throws(
      () => githubTrackerFromSettings(loadSettings({ GITHUB_TOKEN: TOKEN })),
      (error: unknown) => error instanceof SettingsError && /GITHUB_REPO/.test(error.message) && !JSON.stringify(error).includes(TOKEN),
    );
    assert.throws(
      () => githubTrackerFromSettings(loadSettings({ GITHUB_REPO: 'acme/widgets' })),
      (error: unknown) => error instanceof SettingsError && /GITHUB_TOKEN/.test(String((error as SettingsError).problems)),
    );
  });
});
