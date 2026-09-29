import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DevinError } from '../src/devin/errors.ts';
import { DevinSetupClient } from '../src/devin/setup.ts';
import { API_KEY, ORG_ID } from './helpers/devin.ts';

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function recorder(responses: unknown[]): { calls: Call[]; client: DevinSetupClient } {
  const calls: Call[] = [];
  const client = new DevinSetupClient({
    apiKey: API_KEY,
    orgId: ORG_ID,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push({
        method: init.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.searchParams,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = responses.shift();
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next), { status: 200 });
    },
  });
  return { calls, client };
}

describe('Devin setup client (separately callable, includes beta endpoints)', () => {
  it('syncs playbooks and Knowledge notes through the v3 endpoints', async () => {
    const playbook = { playbook_id: 'playbook-1', title: 'Triage', body: 'b', macro: null, updated_at: 1 };
    const note = { note_id: 'note-1', name: 'Fast tests', body: 'npm test', trigger: 'running tests', is_enabled: true, pinned_repo: 'acme/widgets', folder_path: '/', updated_at: 1 };
    const { calls, client } = recorder([
      { items: [playbook], has_next_page: true, end_cursor: 'c1' },
      { items: [], has_next_page: false },
      playbook,
      playbook,
      { items: [note], has_next_page: false },
      note,
      note,
    ]);
    assert.deepEqual(await client.listPlaybooks(), [playbook]);
    assert.equal(calls[1]?.query.get('after'), 'c1');
    await client.createPlaybook({ title: 'Triage', body: 'b' });
    await client.updatePlaybook('playbook-1', { title: 'Triage', body: 'b2' });
    await client.listKnowledgeNotes({ pinnedRepo: 'acme/widgets' });
    await client.createKnowledgeNote({ name: 'Fast tests', body: 'npm test', trigger: 'running tests', pinnedRepo: 'acme/widgets' });
    await client.updateKnowledgeNote('note-1', { name: 'Fast tests', body: 'npm test', trigger: 'running tests' });
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        `GET /v3/organizations/${ORG_ID}/playbooks`,
        `GET /v3/organizations/${ORG_ID}/playbooks`,
        `POST /v3/organizations/${ORG_ID}/playbooks`,
        `PUT /v3/organizations/${ORG_ID}/playbooks/playbook-1`,
        `GET /v3/organizations/${ORG_ID}/knowledge/notes`,
        `POST /v3/organizations/${ORG_ID}/knowledge/notes`,
        `PUT /v3/organizations/${ORG_ID}/knowledge/notes/note-1`,
      ],
    );
    assert.equal(calls[4]?.query.get('pinned_repo'), 'acme/widgets');
    assert.deepEqual(calls[5]?.body, { name: 'Fast tests', body: 'npm test', trigger: 'running tests', pinned_repo: 'acme/widgets' });
  });

  it('indexes the repository and manages blueprints and builds through v3beta1', async () => {
    const blueprint = { blueprint_id: 'bp-1', type: 'repo', repo_name: 'acme/widgets', created_at: 1, updated_at: 1 };
    const build = { build_id: 'build-1', status: 'pending', pinned: false, started_at: null, completed_at: null };
    const { calls, client } = recorder([
      { repository_path: 'acme/widgets', indexing_enabled: true, branches: ['main'] },
      { indexing_enabled: true, latest_indexes: [] },
      { data: [blueprint] },
      blueprint,
      blueprint,
      build,
      { ...build, status: 'succeeded' },
    ]);
    await client.indexRepository('acme/widgets', ['main']);
    await client.getRepositoryIndexing('acme/widgets');
    assert.deepEqual(await client.listBlueprints('acme/widgets'), [blueprint]);
    await client.createBlueprint({ contents: 'initialize: npm ci', repoName: 'acme/widgets' });
    await client.updateBlueprint('bp-1', { contents: 'initialize: npm ci --silent' });
    await client.triggerBuild();
    assert.equal((await client.getBuild('build-1')).status, 'succeeded');
    const beta = `/v3beta1/organizations/${ORG_ID}`;
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        `PUT ${beta}/repositories/acme/widgets/indexing`,
        `GET ${beta}/repositories/acme/widgets/indexing`,
        `GET ${beta}/snapshot-setup/blueprints`,
        `POST ${beta}/snapshot-setup/blueprints`,
        `PATCH ${beta}/snapshot-setup/blueprints/bp-1`,
        `POST ${beta}/snapshot-setup/builds`,
        `GET ${beta}/snapshot-setup/builds/build-1`,
      ],
    );
    assert.deepEqual(calls[0]?.body, { branch_names: ['main'] });
    assert.equal(calls[2]?.query.get('repo_name'), 'acme/widgets');
  });

  it('reports provider errors with the key redacted', async () => {
    const { client } = recorder([new Response(JSON.stringify({ title: 'Unauthorized', status: 401, detail: `bad ${API_KEY}` }), { status: 401 })]);
    await assert.rejects(client.listPlaybooks(), (error) => {
      assert.ok(error instanceof DevinError);
      assert.equal(error.kind, 'auth');
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
  });
});
