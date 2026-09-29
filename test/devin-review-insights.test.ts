import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { toModelInsights } from '../src/devin/insights.ts';
import { correctionMessage, DEVIN_REVIEW_BOT_LOGIN, REVIEW_AUTO_FIX, reviewFindings, type ReviewThreadInput } from '../src/devin/review.ts';
import { validateSessionInsights } from '../src/model/validate.ts';
import { forbidRealNetwork, HEAD_SHA, offlineClient, ORG_ID, PR_URL } from './helpers/devin.ts';

const INPUT = { bugKey: 'acme/widgets#42', route: 'fix' as const, prompt: 'Fix acme/widgets#42' };

function thread(id: string, author: string, overrides: Partial<ReviewThreadInput> = {}): ReviewThreadInput {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/chart/legend.ts',
    line: 12,
    comments: [{ authorLogin: author, body: `Finding ${id}`, url: `${PR_URL}#discussion_${id}`, createdAt: '2026-09-29T10:00:00Z' }],
    ...overrides,
  };
}

before(forbidRealNetwork);

describe('Devin Review', () => {
  it('requests a review and reports it pending, then completed, for the current head only', async () => {
    const { offline, client } = offlineClient();
    offline.pullRequestHeads.set(PR_URL, HEAD_SHA);

    const requested = await client.requestReview(PR_URL, HEAD_SHA);
    assert.equal(offline.requests.at(-1)?.method, 'POST');
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/pr-reviews`);
    assert.deepEqual(offline.requests.at(-1)?.body, { pr_url: PR_URL });
    assert.equal(requested.status, 'pending');

    const running = offline.reviews.get(PR_URL);
    assert.ok(running);
    running.status = 'running';
    const stillPending = await client.getReview(PR_URL, HEAD_SHA);
    assert.ok(stillPending.status === 'pending');
    assert.equal(stillPending.providerStatus, 'running');
    assert.equal(offline.requests.at(-1)?.query.get('pr_url'), PR_URL);
    assert.equal(offline.requests.at(-1)?.query.get('commit_sha'), HEAD_SHA);
    assert.equal(reviewFindings(stillPending, []).status, 'unavailable', 'no findings claim before completion');

    running.status = 'completed';
    const completed = await client.getReview(PR_URL, HEAD_SHA);
    assert.equal(completed.status, 'completed');

    const stale = await client.getReview(PR_URL, 'f'.repeat(40));
    assert.ok(stale.status === 'unavailable');
    assert.equal(stale.reason, 'not-requested');
  });

  it('reports errored, cancelled, skipped, other-commit and unknown statuses without claiming success', async () => {
    const { offline, client } = offlineClient();
    offline.pullRequestHeads.set(PR_URL, HEAD_SHA);
    await client.requestReview(PR_URL);
    const review = offline.reviews.get(PR_URL);
    assert.ok(review);
    const expectations: [string, string, string | undefined][] = [
      ['errored', 'error', undefined],
      ['cancelled', 'unavailable', 'cancelled'],
      ['skipped', 'unavailable', 'skipped'],
      ['exploded', 'unavailable', 'unknown-status'],
    ];
    for (const [providerStatus, status, reason] of expectations) {
      review.status = providerStatus;
      const state = await client.getReview(PR_URL, HEAD_SHA);
      assert.equal(state.status, status, providerStatus);
      if (reason !== undefined) assert.ok(state.status === 'unavailable' && state.reason === reason);
      assert.equal(reviewFindings(state, []).status, 'unavailable');
    }

    offline.failNext({ path: '/pr-reviews', status: 200, body: { ...review, status: 'completed', commit_sha: 'f'.repeat(40) } });
    const other = await client.getReview(PR_URL, HEAD_SHA);
    assert.ok(other.status === 'unavailable');
    assert.equal(other.reason, 'different-commit');
  });

  it('reports Review unavailable when disabled, forbidden or never requested', async () => {
    const disabled = offlineClient({ reviewEnabled: false });
    const off = await disabled.client.requestReview(PR_URL, HEAD_SHA);
    assert.ok(off.status === 'unavailable');
    assert.equal(off.reason, 'disabled');
    assert.equal(disabled.offline.requests.length, 0, 'disabled Review makes no provider call');

    const { offline, client } = offlineClient();
    const missing = await client.getReview(PR_URL, HEAD_SHA);
    assert.ok(missing.status === 'unavailable');
    assert.equal(missing.reason, 'not-requested');

    offline.failNext({ path: '/pr-reviews', status: 403, body: { title: 'Forbidden', status: 403 } });
    const forbidden = await client.requestReview(PR_URL, HEAD_SHA);
    assert.ok(forbidden.status === 'unavailable');
    assert.equal(forbidden.reason, 'forbidden');
  });

  it('lists only unresolved Devin Review threads as findings and requires the threads to be supplied', async () => {
    const { offline, client } = offlineClient();
    offline.pullRequestHeads.set(PR_URL, HEAD_SHA);
    await client.requestReview(PR_URL, HEAD_SHA);
    const stored = offline.reviews.get(PR_URL);
    assert.ok(stored);
    stored.status = 'completed';
    const review = await client.getReview(PR_URL, HEAD_SHA);

    const withoutThreads = reviewFindings(review, null);
    assert.ok(withoutThreads.status === 'unavailable');
    assert.equal(withoutThreads.reason, 'threads-not-supplied');

    const findings = reviewFindings(review, [
      thread('1', DEVIN_REVIEW_BOT_LOGIN),
      thread('2', DEVIN_REVIEW_BOT_LOGIN, { isResolved: true }),
      thread('3', 'octocat'),
      thread('4', DEVIN_REVIEW_BOT_LOGIN, { isOutdated: true, line: null }),
      thread('5', DEVIN_REVIEW_BOT_LOGIN, { comments: [] }),
    ]);
    assert.ok(findings.status === 'known');
    assert.equal(findings.commitSha, HEAD_SHA);
    assert.deepEqual(findings.unresolved.map((finding) => [finding.threadId, finding.outdated]), [['1', false], ['4', true]]);

    const clean = reviewFindings(review, [thread('2', DEVIN_REVIEW_BOT_LOGIN, { isResolved: true })]);
    assert.deepEqual(clean, { status: 'known', commitSha: HEAD_SHA, unresolved: [] });
  });

  it('sends findings back to the same session as a separate corrective capability', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const finding = { threadId: '1', path: 'src/a.ts', line: 3, body: 'Null check missing', url: `${PR_URL}#d1`, outdated: false };
    await client.sendReviewCorrections(created.session.id, [finding]);
    const request = offline.requests.at(-1);
    assert.equal(request?.path, `/v3/organizations/${ORG_ID}/sessions/${created.session.id}/messages`);
    assert.deepEqual(request?.body, { message: correctionMessage([finding]) });
    assert.match(correctionMessage([finding]), /src\/a\.ts:3[\s\S]*Null check missing/);
    await assert.rejects(client.sendReviewCorrections(created.session.id, []), /no findings/);
  });

  it('does not assume Auto-Fix and names the admin action that enables it', () => {
    assert.equal(REVIEW_AUTO_FIX.state, 'unknown');
    assert.equal(REVIEW_AUTO_FIX.configurableByApi, false);
    assert.match(REVIEW_AUTO_FIX.userAction, /Responding to bots/);
  });
});

describe('Session Insights', () => {
  it('reports insights unavailable until generated, pending while generating, and failed generation', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const id = created.session.id;

    const none = await client.getInsights(id);
    assert.ok(none.status === 'unavailable');
    assert.equal(none.reason, 'not-generated');
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/sessions/${id}/insights`);

    assert.deepEqual(await client.generateInsights(id), { status: 'started' });
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/sessions/${id}/insights/generate`);
    assert.deepEqual(await client.getInsights(id), { status: 'pending' });

    offline.insights.set(id, { analysis_status: 'failed', analysis: null });
    const failed = await client.getInsights(id);
    assert.ok(failed.status === 'unavailable');
    assert.equal(failed.reason, 'failed');

    const unknown = await client.getInsights('devin-missing');
    assert.ok(unknown.status === 'unavailable');
    assert.equal(unknown.reason, 'not-found');

    offline.failNext({ path: '/insights', status: 403, body: { title: 'Forbidden', status: 403 } });
    const forbidden = await client.getInsights(id);
    assert.ok(forbidden.status === 'unavailable');
    assert.equal(forbidden.reason, 'forbidden');
  });

  it('retains issues, action items, the suggested prompt and Knowledge used', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const id = created.session.id;
    offline.updateSession(id, { status: 'exit', acus_consumed: 2.5 });
    offline.insights.set(id, {
      analysis_status: 'completed',
      analysis: {
        issues: [{ id: 'i1', title: 'Slow test setup', issue: 'npm ci took 6 minutes', impact: 'high', label: 'environment' }],
        action_items: [{ action_item: 'Cache node_modules in the blueprint', type: 'machine_setup', issue_id: 'i1' }],
        suggested_prompt: { original_prompt: 'Fix it', suggested_prompt: 'Fix it; run npm test -- {files}', feedback_items: [] },
        note_usage: {
          good_usages: [{ note_id: 'note-fast-tests', reason: 'Used the fast suite', message: 'm' }],
          bad_usages: [{ note_id: 'note-old-image', reason: 'Outdated image name', message: 'm' }],
        },
      },
    });
    assert.deepEqual(await client.generateInsights(id), { status: 'already-exists' });
    const result = await client.getInsights(id);
    assert.ok(result.status === 'available');
    const { insights } = result;
    assert.deepEqual(insights.acus, { status: 'reported', acus: 2.5 });
    assert.equal(insights.issues[0]?.issue, 'npm ci took 6 minutes');
    assert.deepEqual(insights.actionItems, [{ type: 'machine_setup', text: 'Cache node_modules in the blueprint', issueId: 'i1' }]);
    assert.equal(insights.suggestedPrompt?.suggested, 'Fix it; run npm test -- {files}');
    assert.deepEqual(insights.knowledgeUsed?.helpful.map((note) => note.noteId), ['note-fast-tests']);
    assert.deepEqual(insights.knowledgeUsed?.unhelpful.map((note) => note.noteId), ['note-old-image']);
    assert.equal(insights.skillsUsed, null);

    const model = toModelInsights(insights);
    assert.deepEqual(validateSessionInsights(model, 'insights'), []);
    assert.equal(model.acuUsed, 2.5);
    assert.match(model.notes ?? '', /Slow test setup[\s\S]*Cache node_modules[\s\S]*Suggested prompt[\s\S]*note-fast-tests/);
  });

  it('keeps ACUs unknown in the model projection when usage is zero', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    offline.insights.set(created.session.id, { analysis_status: 'completed', analysis: { issues: [], action_items: [] } });
    const result = await client.getInsights(created.session.id);
    assert.ok(result.status === 'available');
    assert.deepEqual(toModelInsights(result.insights), { acuUsed: null, notes: null });
  });
});
