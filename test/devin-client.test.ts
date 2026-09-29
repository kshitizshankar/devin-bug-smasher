import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { before, describe, it } from 'node:test';
import { loadSettings } from '../src/config/settings.ts';
import { DevinClient } from '../src/devin/client.ts';
import { DevinError } from '../src/devin/errors.ts';
import { sessionStatusEvent } from '../src/devin/sessions.ts';
import { estimateCostUsd } from '../src/devin/usage.ts';
import { STRUCTURED_OUTPUT_SCHEMA } from '../src/devin/structured-output.ts';
import { API_KEY, COMPLETE_TRIAGE, forbidRealNetwork, offlineClient, ORG_ID } from './helpers/devin.ts';

const BUG = 'acme/widgets#42';
const INPUT = { bugKey: BUG, route: 'triage' as const, prompt: 'Investigate acme/widgets#42', repos: ['acme/widgets'] };

async function devinError(promise: Promise<unknown>): Promise<DevinError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DevinError, `expected DevinError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a DevinError');
}

before(forbidRealNetwork);

describe('Devin client: sessions', () => {
  it('creates a session with the documented request: cap, identifying tags, schema, no secrets', async () => {
    const { offline, client } = offlineClient();
    const result = await client.createSession(INPUT);
    assert.equal(result.outcome, 'created');
    assert.ok(result.outcome === 'created');

    const request = offline.requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/v3/organizations/${ORG_ID}/sessions`);
    assert.equal(request.authorized, true);
    const body = request.body as Record<string, unknown>;
    assert.equal(body.max_acu_limit, 5);
    assert.deepEqual(body.tags, ['bug-smasher', `bug-smasher:bug=${BUG}`, 'bug-smasher:route=triage', 'bug-smasher:attempt=attempt-1']);
    assert.deepEqual(body.structured_output_schema, STRUCTURED_OUTPUT_SCHEMA);
    assert.equal(body.structured_output_required, false);
    assert.deepEqual(body.secret_ids, []);
    assert.deepEqual(body.session_secrets, []);
    assert.deepEqual(body.repos, ['acme/widgets']);

    assert.equal(result.session.id, 'devin-offline0001');
    assert.deepEqual(result.session.activity, { kind: 'starting' });
    assert.equal(result.session.liveState, 'starting');
    assert.deepEqual(result.session.structuredOutput, { status: 'absent' });
  });

  it('uses MAX_ACU_PER_SESSION from settings and refuses to build without credentials', () => {
    const offline = offlineClient().offline;
    const settings = loadSettings({ DEVIN_API_KEY: API_KEY, DEVIN_ORG_ID: ORG_ID, MAX_ACU_PER_SESSION: '9' });
    const client = DevinClient.fromSettings(settings, { fetch: offline.fetch });
    assert.equal(client.toJSON().maxAcuPerSession, 9);
    assert.throws(() => DevinClient.fromSettings(loadSettings({})), (error) => error instanceof DevinError && error.kind === 'not-configured');
  });

  it('distinguishes working, waiting, idle, suspended and ended; none of them is completion', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const id = created.session.id;
    const cases = [
      { status: 'running', status_detail: 'working', kind: 'working', live: 'running' },
      { status: 'running', status_detail: 'waiting_for_user', kind: 'waiting', live: 'blocked' },
      { status: 'running', status_detail: 'waiting_for_approval', kind: 'waiting', live: 'blocked' },
      { status: 'running', status_detail: 'finished', kind: 'idle', live: 'blocked' },
      { status: 'suspended', status_detail: 'inactivity', kind: 'suspended', live: 'blocked' },
      { status: 'suspended', status_detail: 'out_of_credits', kind: 'suspended', live: 'blocked' },
      { status: 'exit', status_detail: null, kind: 'ended', live: 'ended' },
      { status: 'error', status_detail: 'error', kind: 'ended', live: 'ended' },
    ] as const;
    for (const expected of cases) {
      offline.updateSession(id, { status: expected.status, status_detail: expected.status_detail });
      const session = await client.getSession(id);
      assert.equal(session.activity.kind, expected.kind, `${expected.status}/${expected.status_detail}`);
      assert.equal(session.liveState, expected.live);
      assert.deepEqual(session.structuredOutput, { status: 'absent' }, 'status never implies a result');
      assert.deepEqual(sessionStatusEvent(session), { type: 'session-status', sessionId: id, liveState: expected.live });
    }

    offline.updateSession(id, { status: 'suspended', status_detail: 'inactivity' });
    const inactive = await client.getSession(id);
    assert.ok(inactive.activity.kind === 'suspended');
    assert.equal(inactive.activity.resumable, true);
    offline.updateSession(id, { status: 'suspended', status_detail: 'out_of_credits' });
    const limited = await client.getSession(id);
    assert.ok(limited.activity.kind === 'suspended');
    assert.equal(limited.activity.reason, 'provider-limit');
    assert.equal(limited.activity.resumable, false);
  });

  it('reports unknown provider statuses as unknown and emits no model event', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    offline.updateSession(created.session.id, { status: 'hibernating', status_detail: null });
    const session = await client.getSession(created.session.id);
    assert.equal(session.activity.kind, 'unknown');
    assert.equal(session.liveState, null);
    assert.equal(sessionStatusEvent(session), null);
  });

  it('sends messages, lists them for display, terminates and archives', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const id = created.session.id;

    await client.sendMessage(id, 'The answer is: only on Safari');
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/sessions/${id}/messages`);
    assert.deepEqual(offline.requests.at(-1)?.body, { message: 'The answer is: only on Safari' });
    const messages = await client.listMessages(id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.source, 'user');
    assert.equal(messages[0]?.text, 'The answer is: only on Safari');

    const ended = await client.terminateSession(id, { archive: true });
    assert.equal(offline.requests.at(-1)?.method, 'DELETE');
    assert.equal(offline.requests.at(-1)?.query.get('archive'), 'true');
    assert.equal(ended.liveState, 'ended');
    assert.equal(ended.isArchived, true);

    const second = await client.createSession(INPUT);
    assert.ok(second.outcome === 'created');
    const archived = await client.archiveSession(second.session.id);
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/sessions/${second.session.id}/archive`);
    assert.equal(archived.isArchived, true);
  });
});

describe('Devin client: ambiguous creation and tag reconciliation', () => {
  it('treats a create timeout as ambiguous and reconciles to the session that was created', async () => {
    const { offline, client } = offlineClient();
    offline.failNext({ method: 'POST', path: '/sessions', network: 'timeout', applyFirst: true });
    const result = await client.createSession(INPUT);
    assert.equal(result.outcome, 'ambiguous');
    assert.ok(result.outcome === 'ambiguous');
    assert.equal(result.error.kind, 'timeout');
    assert.equal(result.error.ambiguous, true);
    assert.equal(offline.sessions.size, 1, 'the provider did create it');

    const creates = offline.requests.filter((request) => request.method === 'POST').length;
    const reconciled = await client.reconcileCreate(result);
    assert.equal(reconciled.outcome, 'found');
    assert.ok(reconciled.outcome === 'found');
    assert.ok(reconciled.session.tags.includes(result.tags.attempt));
    assert.equal(offline.requests.filter((request) => request.method === 'POST').length, creates, 'reconciliation never creates');
    const lookup = offline.requests.at(-1);
    assert.equal(lookup?.method, 'GET');
    assert.deepEqual(lookup?.query.getAll('tags'), [result.tags.attempt]);
  });

  it('reports not-found when the ambiguous create never reached the provider', async () => {
    const { offline, client } = offlineClient();
    offline.failNext({ method: 'POST', path: '/sessions', network: 'reset' });
    const result = await client.createSession(INPUT);
    assert.ok(result.outcome === 'ambiguous');
    assert.equal(result.error.kind, 'network');
    assert.deepEqual(await client.reconcileCreate(result), { outcome: 'not-found' });
  });

  it('treats 5xx and unreadable create answers as ambiguous, but 4xx as definite failures', async () => {
    const { offline, client } = offlineClient();
    offline.failNext({ method: 'POST', path: '/sessions', status: 502, applyFirst: true });
    const gateway = await client.createSession(INPUT);
    assert.ok(gateway.outcome === 'ambiguous');
    assert.equal(gateway.error.kind, 'provider');

    offline.failNext({ method: 'POST', path: '/sessions', status: 200, body: { unexpected: true } });
    const unreadable = await client.createSession(INPUT);
    assert.ok(unreadable.outcome === 'ambiguous');
    assert.equal(unreadable.error.kind, 'invalid-response');

    offline.failNext({ method: 'POST', path: '/sessions', status: 422, body: { title: 'Validation Error', status: 422 } });
    const invalid = await devinError(client.createSession(INPUT));
    assert.equal(invalid.kind, 'invalid-request');
    assert.equal(invalid.ambiguous, false);
  });

  it('surfaces duplicates instead of choosing one', async () => {
    const { offline, client } = offlineClient({ newAttemptId: () => 'same-attempt' });
    await client.createSession(INPUT);
    offline.failNext({ method: 'POST', path: '/sessions', network: 'timeout', applyFirst: true });
    const result = await client.createSession(INPUT);
    assert.ok(result.outcome === 'ambiguous');
    const reconciled = await client.reconcileCreate(result);
    assert.equal(reconciled.outcome, 'duplicates');
    assert.ok(reconciled.outcome === 'duplicates');
    assert.equal(reconciled.sessions.length, 2);
  });

  it('finds sessions carrying all tags, across pages, even if the provider matches any tag', async () => {
    const { client } = offlineClient({}, { maxPageSize: 2 });
    for (let index = 0; index < 3; index += 1) await client.createSession(INPUT);
    await client.createSession({ ...INPUT, route: 'fix' });
    await client.createSession({ ...INPUT, bugKey: 'acme/widgets#43' });

    assert.equal((await client.findBugSessions(BUG)).length, 4);
    const triage = await client.findSessions([`bug-smasher:bug=${BUG}`, 'bug-smasher:route=triage']);
    assert.equal(triage.length, 3);
    assert.ok(triage.every((session) => session.tags.includes('bug-smasher:route=triage')));
  });
});

describe('Devin client: malformed provider answers', () => {
  it('fails lookups instead of truncating when a page promises more results without a cursor', async () => {
    const { offline, client } = offlineClient();
    await client.createSession(INPUT);
    offline.failNext({ method: 'GET', path: '/sessions', status: 200, body: { items: [], has_next_page: true, end_cursor: null } });
    const error = await devinError(client.findBugSessions(BUG));
    assert.equal(error.kind, 'invalid-response');
    assert.match(error.message, /end_cursor/);
  });

  it('lists long conversations in full across many pages', async () => {
    const { client } = offlineClient({}, { maxPageSize: 1 });
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    for (let index = 0; index < 25; index += 1) await client.sendMessage(created.session.id, `reply ${index}`);
    const messages = await client.listMessages(created.session.id);
    assert.equal(messages.length, 25);
    assert.equal(messages.at(-1)?.text, 'reply 24');
  });

  it('refuses to follow redirects that could carry the API key elsewhere', async () => {
    const inits: RequestInit[] = [];
    const client = new DevinClient({
      apiKey: API_KEY,
      orgId: ORG_ID,
      maxAcuPerSession: 5,
      reviewEnabled: true,
      fetch: async (_url, init) => {
        inits.push(init);
        return new Response(JSON.stringify({ items: [], has_next_page: false, end_cursor: null }), { status: 200 });
      },
    });
    await client.findBugSessions(BUG);
    assert.equal(inits[0]?.redirect, 'error');
  });

  it('fails lookups when a page omits has_next_page', async () => {
    const { offline, client } = offlineClient();
    offline.failNext({ method: 'GET', path: '/sessions', status: 200, body: { items: [] } });
    const error = await devinError(client.findBugSessions(BUG));
    assert.equal(error.kind, 'invalid-response');
    assert.match(error.message, /has_next_page/);
  });

  it('refuses a plaintext base URL except for loopback hosts', () => {
    const base = { apiKey: API_KEY, orgId: ORG_ID, maxAcuPerSession: 5, reviewEnabled: true };
    assert.throws(() => new DevinClient({ ...base, baseUrl: 'http://api.devin.ai' }), (error) => error instanceof DevinError && error.kind === 'not-configured');
    assert.doesNotThrow(() => new DevinClient({ ...base, baseUrl: 'http://127.0.0.1:9999' }));
    assert.doesNotThrow(() => new DevinClient({ ...base, baseUrl: 'https://api.devin.ai/' }));
  });

  it('scrubs credentials from provider text before it can reach model events', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const github = 'ghp_' + 'A'.repeat(36);
    offline.updateSession(created.session.id, {
      structured_output: { phase: 'triage', status: 'needs_input', question: `Is ${API_KEY} or ${github} the right token?` },
    });
    const session = await client.getSession(created.session.id);
    const text = JSON.stringify(session);
    assert.ok(!text.includes(API_KEY) && !text.includes(github));
    assert.ok(session.structuredOutput.status === 'valid');
  });

  it('treats out-of-range timestamps as an unusable create answer, not a crash', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const session = offline.sessions.get(created.session.id);
    assert.ok(session);
    for (const created_at of [1e20, Number.MAX_SAFE_INTEGER]) {
      offline.failNext({ method: 'POST', path: '/sessions', status: 200, body: { ...session, created_at } });
      const result = await client.createSession(INPUT);
      assert.ok(result.outcome === 'ambiguous');
      assert.equal(result.error.kind, 'invalid-response');
      assert.match(result.error.message, /created_at/);
    }
    offline.failNext({ path: `/sessions/${created.session.id}`, status: 200, body: { ...session, updated_at: 1e20 } });
    assert.equal((await devinError(client.getSession(created.session.id))).kind, 'invalid-response');
  });
});

describe('Devin client: provider errors and redaction', () => {
  it('maps authentication, permission, rate-limit and provider errors to typed kinds', async () => {
    const { offline, client } = offlineClient();
    const bad = new DevinClient({ apiKey: 'cog_wrongKey000', orgId: ORG_ID, maxAcuPerSession: 5, reviewEnabled: true, fetch: offline.fetch });
    const auth = await devinError(bad.getSession('devin-x'));
    assert.equal(auth.kind, 'auth');
    assert.equal(auth.status, 401);

    offline.failNext({ path: '/sessions/devin-x', status: 403, body: { title: 'Forbidden', status: 403 } });
    assert.equal((await devinError(client.getSession('devin-x'))).kind, 'forbidden');

    offline.failNext({ path: '/sessions/devin-x', status: 429, headers: { 'retry-after': '30' }, body: { title: 'Too Many Requests', status: 429 } });
    const limited = await devinError(client.getSession('devin-x'));
    assert.equal(limited.kind, 'rate-limited');
    assert.equal(limited.retryAfterSeconds, 30);

    offline.failNext({ path: '/sessions/devin-x', status: 500 });
    const provider = await devinError(client.getSession('devin-x'));
    assert.equal(provider.kind, 'provider');
    assert.equal(provider.ambiguous, false, 'a failed GET changed nothing');

    const missing = await devinError(client.getSession('devin-x'));
    assert.equal(missing.kind, 'not-found');

    offline.failNext({ path: '/sessions/devin-x', status: 409, body: { title: 'Conflict', status: 409 } });
    assert.equal((await devinError(client.sendMessage('devin-x', 'hello'))).kind, 'conflict');
  });

  it('never exposes the API key in errors, serialized values, logs or inspection', async () => {
    const { offline, client } = offlineClient();
    offline.failNext({
      path: '/sessions/devin-x',
      status: 401,
      body: { title: 'Unauthorized', status: 401, detail: `Token ${API_KEY} rejected (Authorization: Bearer ${API_KEY})` },
    });
    const error = await devinError(client.getSession('devin-x'));
    offline.failNext({ path: '/sessions/devin-y', status: 400, body: { title: 'Bad', status: 400, detail: 'other cog_leakedToken99 seen' } });
    const other = await devinError(client.getSession('devin-y'));
    const created = await client.createSession(INPUT);

    const surfaces = [
      error.message,
      String(error),
      error.stack ?? '',
      JSON.stringify(error),
      inspect(error),
      other.message,
      JSON.stringify(client),
      inspect(client, { showHidden: true, depth: 10 }),
      JSON.stringify(created),
      JSON.stringify(offline.requests),
    ];
    for (const surface of surfaces) {
      assert.ok(!surface.includes(API_KEY), `API key leaked in: ${surface.slice(0, 120)}`);
      assert.ok(!surface.includes('cog_leakedToken99'));
    }
    assert.match(error.message, /\[redacted\]/);
  });
});

describe('Devin client: usage and metrics', () => {
  it('reports zero ACUs as unavailable and derives no dollar cost from them', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    assert.deepEqual(created.session.acus, { status: 'unavailable', reason: 'zero-reported' });
    assert.equal(estimateCostUsd(created.session.acus, 2.25), null);

    const usage = await client.getSessionUsage(created.session.id);
    assert.ok(usage.status === 'available');
    assert.deepEqual(usage.value.total, { status: 'unavailable', reason: 'zero-reported' });
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/consumption/daily/sessions/${created.session.id}`);

    offline.updateSession(created.session.id, { acus_consumed: 3.5 });
    const session = await client.getSession(created.session.id);
    assert.deepEqual(session.acus, { status: 'reported', acus: 3.5 });
    assert.equal(estimateCostUsd(session.acus, 2.25), 7.88);
    assert.equal(estimateCostUsd(session.acus, null), null, 'no configured price, no cost');
  });

  it('reports missing ACU fields and forbidden metrics as unavailable', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    offline.updateSession(created.session.id, { acus_consumed: undefined as unknown as number });
    assert.deepEqual((await client.getSession(created.session.id)).acus, { status: 'unavailable', reason: 'not-reported' });

    const window = { after: new Date('2026-09-01T00:00:00Z'), before: new Date('2026-09-29T00:00:00Z') };
    const usage = await client.getUsageMetrics(window);
    assert.equal(usage.status, 'unavailable');
    assert.ok(usage.status === 'unavailable');
    assert.equal(usage.reason, 'forbidden');
    assert.equal(offline.requests.at(-1)?.query.get('time_after'), String(Date.parse('2026-09-01T00:00:00Z') / 1000));
  });

  it('reads usage, session and PR metrics with documented windows', async () => {
    const { offline, client } = offlineClient();
    offline.metrics = {
      usage: { sessions_count: 12, searches_count: 3, prs_created_count: 5, prs_merged_count: 4 },
      sessions: {
        sessions_created_count: 12,
        sessions_created_by_size: {},
        sessions_created_by_origin: {},
        sessions_created_with_playbook_count: 10,
        sessions_created_with_search_count: 0,
        sessions_with_merged_prs_count: 4,
        sessions_with_merged_prs_by_size: {},
        avg_acus_per_session: 0,
      },
      prs: { prs_created_count: 5, prs_opened_count: 1, prs_merged_count: 4, prs_closed_count: 0 },
    };
    const window = { after: new Date('2026-09-01T00:00:00Z'), before: new Date('2026-09-29T00:00:00Z') };
    assert.deepEqual(await client.getUsageMetrics(), {
      status: 'available',
      value: { sessionsCount: 12, searchesCount: 3, prsCreatedCount: 5, prsMergedCount: 4 },
    });
    const sessions = await client.getSessionMetrics(window);
    assert.ok(sessions.status === 'available');
    assert.equal(sessions.value.sessionsWithMergedPrsCount, 4);
    assert.deepEqual(sessions.value.avgAcusPerSession, { status: 'unavailable', reason: 'zero-reported' });
    assert.equal(offline.requests.at(-1)?.path, `/v3/organizations/${ORG_ID}/metrics/sessions`);
    const prs = await client.getPrMetrics(window);
    assert.ok(prs.status === 'available');
    assert.equal(prs.value.prsMergedCount, 4);

    const tooLong = { after: new Date('2026-01-01T00:00:00Z'), before: new Date('2026-09-29T00:00:00Z') };
    assert.equal((await devinError(client.getPrMetrics(tooLong))).kind, 'invalid-request');
  });
});

describe('Devin client: structured output drives nothing unless complete', () => {
  it('exposes a valid triage result only once every field is present', async () => {
    const { offline, client } = offlineClient();
    const created = await client.createSession(INPUT);
    assert.ok(created.outcome === 'created');
    const id = created.session.id;
    offline.updateSession(id, { status: 'running', status_detail: 'finished', structured_output: { phase: 'triage', status: 'triage_complete', title: 'x' } });
    const partial = await client.getSession(id);
    assert.equal(partial.structuredOutput.status, 'incomplete');

    offline.updateSession(id, { structured_output: COMPLETE_TRIAGE });
    const complete = await client.getSession(id);
    assert.equal(complete.structuredOutput.status, 'valid');
  });
});
