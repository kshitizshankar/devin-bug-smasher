import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadSettings } from '../src/config/settings.ts';
import { DevinSetupClient } from '../src/devin/setup.ts';
import { desiredLabels, desiredNotes, ISSUE_FORM_PATH, playbookTitle } from '../src/operator/assets.ts';
import { failedSteps, parseBuildLog } from '../src/operator/build-log.ts';
import { calculateMetrics } from '../src/metrics/calculate.ts';
import type { Figure } from '../src/metrics/types.ts';
import { runCommand } from '../src/operator/cli.ts';
import { FIGURE_HEADER, renderResults } from '../src/operator/report.ts';
import { BugStore } from '../src/store/bug-store.ts';
import { GitHubTracker } from '../src/tracker/github.ts';
import { API_KEY, ORG_ID } from './helpers/devin.ts';
import { FakeDevinSetup } from './helpers/fake-devin-setup.ts';
import { FakeGitHub } from './helpers/fake-github.ts';
import { Bug, input as metricsInput, NO_COST, unavailableEvidence } from './helpers/metrics.ts';
import { fullEvidence, liveBugs, recordSets } from './helpers/metrics-fixture.ts';
import { enroll, LABEL } from './helpers/model.ts';
import { repoRoot, startService } from './helpers/service.ts';

const TOKEN = 'ghp_fakeTokenValue0123456789';
const TARGET = 'acme/widgets';
const BLUEPRINT = 'initialize: |\n  npm ci\n';
const CHECK = 'npx vitest run {files} --reporter=junit --outputFile={results}';
const IMAGE = 'node:22-bookworm';

interface Harness {
  github: FakeGitHub;
  devin: FakeDevinSetup;
  dir: string;
  run: (argv: string[], env?: Record<string, string>) => Promise<{ code: number | null; out: string; err: string }>;
  close: () => Promise<void>;
}

async function harness(options: { reachable?: boolean } = {}): Promise<Harness> {
  const github = await FakeGitHub.start({ token: TOKEN });
  const devin = new FakeDevinSetup(ORG_ID);
  if (options.reachable !== false) devin.reachable = [TARGET, 'acme/other'];
  const dir = await mkdtemp(join(tmpdir(), 'bug-smasher-operator-'));
  await mkdir(join(dir, 'setup'));
  await writeFile(join(dir, 'setup/blueprint.yaml'), BLUEPRINT);
  const env = {
    GITHUB_REPO: TARGET,
    GITHUB_TOKEN: TOKEN,
    DEVIN_API_KEY: API_KEY,
    DEVIN_ORG_ID: ORG_ID,
    CHECK_COMMAND: CHECK,
    VERIFY_IMAGE: IMAGE,
  };
  return {
    github,
    devin,
    dir,
    run: async (argv, overrides = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCommand(argv, {
        env: { ...env, ...overrides },
        cwd: dir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        githubBaseUrl: github.baseUrl,
        devinFetch: devin.fetch,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    close: async () => {
      await github.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function withHarness(run: (h: Harness) => Promise<void>, options: { reachable?: boolean } = {}): Promise<void> {
  const h = await harness(options);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

function writeCount(h: Harness): number {
  return h.github.writes().length + h.devin.writes().length;
}

describe('operator setup', () => {
  it('configures an unconfigured target, then a second run changes nothing', async () => {
    await withHarness(async (h) => {
      const first = await h.run(['setup']);
      assert.equal(first.code, 0, first.err);
      assert.deepEqual(
        h.github.repositoryLabels().map((label) => label.name).sort(),
        ['bug-smasher', 'devin-builds-feature', 'needs-engineer', 'needs-triage'],
      );
      assert.match(h.github.file(ISSUE_FORM_PATH) ?? '', /^name: Bug report/);
      assert.deepEqual(h.devin.playbooks.map((playbook) => playbook.title), [playbookTitle(TARGET)]);
      assert.deepEqual(
        h.devin.notes.map((note) => [note.name, note.pinned_repo]),
        [
          ['Bug Smasher: fast tests', TARGET],
          ['Bug Smasher: verification image', TARGET],
          ['Bug Smasher: observed pitfalls', TARGET],
        ],
      );
      assert.equal(h.devin.indexing.get(TARGET), true);
      assert.deepEqual(h.devin.blueprints.map((blueprint) => [blueprint.repo_name, blueprint.contents]), [[TARGET, BLUEPRINT]]);
      assert.equal(h.devin.builds.length, 1);
      assert.match(first.out, /env-status -- build-/);

      const writes = writeCount(h);
      const second = await h.run(['setup']);
      assert.equal(second.code, 0, second.err);
      assert.match(second.out, /Nothing to change: acme\/widgets is already set up/);
      assert.equal(writeCount(h), writes, 'the second run must not write anything');
    });
  });

  it('updates only the label and Knowledge note that differ', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.run(['setup'])).code, 0);
      const triage = h.github.repositoryLabels().find((label) => label.name === 'needs-triage');
      assert.ok(triage);
      // Drift one label and one note outside the tool.
      await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).updateLabel('needs-triage', {
        name: 'Needs-Triage',
        color: '000000',
        description: triage.description ?? '',
      });
      const note = h.devin.notes.find((candidate) => candidate.name === 'Bug Smasher: fast tests');
      assert.ok(note);
      note.body = 'stale';
      const githubBefore = h.github.writes().length;
      const devinBefore = h.devin.writes().length;

      const result = await h.run(['setup']);
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(
        h.github.writes().slice(githubBefore).map((request) => `${request.method} ${request.route}`),
        ['PATCH labels/Needs-Triage'],
      );
      assert.deepEqual(
        h.devin.writes().slice(devinBefore).map((call) => `${call.method} ${call.path}`),
        [`PUT /v3/organizations/${ORG_ID}/knowledge/notes/${note.note_id}`],
      );
      assert.equal(h.github.repositoryLabels().find((label) => label.name === 'needs-triage')?.color, 'fbca04');
      assert.match(note.body, /Fast tests for acme\/widgets/);
    });
  });

  it('triggers the build a failed setup run left out, and re-enables a disabled note', async () => {
    await withHarness(async (h) => {
      h.devin.failNext((call) => call.method === 'POST' && call.path.endsWith('/snapshot-setup/builds'), 500, { detail: 'unavailable' });
      const interrupted = await h.run(['setup']);
      assert.equal(interrupted.code, 1);
      assert.equal(h.devin.builds.length, 0);
      const note = h.devin.notes.find((candidate) => candidate.name === 'Bug Smasher: verification image');
      assert.ok(note);
      note.is_enabled = false;
      const devinBefore = h.devin.writes().length;

      const resumed = await h.run(['setup']);
      assert.equal(resumed.code, 0, resumed.err);
      assert.deepEqual(
        h.devin.writes().slice(devinBefore).map((call) => `${call.method} ${call.path}`),
        [`PUT /v3/organizations/${ORG_ID}/knowledge/notes/${note.note_id}`, `POST /v3beta1/organizations/${ORG_ID}/snapshot-setup/builds`],
      );
      assert.equal(note.is_enabled, true);
      assert.match((await h.run(['setup'])).out, /Nothing to change/);
    });
  });

  it('stops before any change when Devin cannot reach the target, naming the web-app setting', async () => {
    await withHarness(
      async (h) => {
        const result = await h.run(['setup']);
        assert.equal(result.code, 1);
        assert.match(result.err, /Devin cannot reach acme\/widgets/);
        assert.match(result.err, /Settings > Connections > GitHub/);
        assert.equal(writeCount(h), 0);
        assert.deepEqual(
          h.devin.calls.map((call) => `${call.method} ${call.path}`),
          [`GET /v3beta1/organizations/${ORG_ID}/repositories`],
          'only the read-only availability check is made; no access-grant call',
        );
        assert.deepEqual(h.github.requests, []);
      },
      { reachable: false },
    );
  });

  it('changes only the target and never other repositories or organization-wide resources', async () => {
    await withHarness(async (h) => {
      h.github.seedLabel({ name: 'wontfix', color: 'ffffff', description: 'Not ours' });
      h.devin.playbooks.push({ playbook_id: 'playbook-org', title: 'Org-wide triage', body: 'org', macro: '!triage', updated_at: 1 });
      h.devin.notes.push(
        { note_id: 'note-org', name: 'Bug Smasher: fast tests', body: 'org note', trigger: 't', is_enabled: true, pinned_repo: null, folder_path: '/', updated_at: 1 },
        { note_id: 'note-other', name: 'Bug Smasher: fast tests', body: 'other', trigger: 't', is_enabled: true, pinned_repo: 'acme/other', folder_path: '/', updated_at: 1 },
      );
      h.devin.blueprints.push(
        { blueprint_id: 'bp-org', type: 'org', repo_name: null, contents: 'org: true\n', created_at: 1, updated_at: 1 },
        { blueprint_id: 'bp-other', type: 'repo', repo_name: 'acme/other', contents: 'other: true\n', created_at: 1, updated_at: 1 },
      );
      h.devin.indexing.set('acme/other', false);
      const untouched = JSON.stringify({
        playbook: h.devin.playbooks[0],
        notes: h.devin.notes.slice(),
        blueprints: h.devin.blueprints.slice(),
        label: h.github.repositoryLabels()[0],
      });

      const result = await h.run(['setup']);
      assert.equal(result.code, 0, result.err);
      assert.equal(
        JSON.stringify({
          playbook: h.devin.playbooks[0],
          notes: h.devin.notes.slice(0, 2),
          blueprints: h.devin.blueprints.slice(0, 2),
          label: h.github.repositoryLabels()[0],
        }),
        untouched,
      );
      assert.equal(h.devin.indexing.get('acme/other'), false);
      for (const request of h.github.writes()) assert.ok(!request.route.startsWith('/'), `GitHub write outside the target: ${request.route}`);
      const devinWrites = h.devin.writes();
      for (const call of devinWrites) {
        const body = JSON.stringify(call.body ?? {});
        assert.ok(!/note-org|note-other|bp-org|bp-other|playbook-org|acme\/other/.test(call.path + body), `${call.method} ${call.path}`);
      }
      assert.ok(devinWrites.filter((call) => call.path.includes('knowledge/notes')).every((call) => (call.body as { pinned_repo?: string }).pinned_repo === TARGET));
    });
  });

  it('plans every change in a dry run without writing anything', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['setup', '--dry-run']);
      assert.equal(result.code, 0, result.err);
      assert.equal(writeCount(h), 0);
      for (const change of [
        'would create GitHub label "needs-triage"',
        'would create GitHub label "bug-smasher"',
        'would create GitHub label "needs-engineer"',
        'would create GitHub label "devin-builds-feature"',
        `would create GitHub issue form ${ISSUE_FORM_PATH}`,
        `would create Devin Playbook "${playbookTitle(TARGET)}"`,
        'would create Devin Knowledge note "Bug Smasher: fast tests"',
        'would create Devin Knowledge note "Bug Smasher: verification image"',
        'would create Devin Knowledge note "Bug Smasher: observed pitfalls"',
        'would enable Devin indexing for acme/widgets',
        'would create Devin blueprint for acme/widgets',
        'would trigger Devin environment build',
      ]) {
        assert.ok(result.out.includes(change), `missing "${change}" in:\n${result.out}`);
      }
      assert.match(result.out, /Would make 12 changes/);
    });
  });

  it('redacts credentials that appear in provider errors', async () => {
    await withHarness(async (h) => {
      h.devin.failNext((call) => call.path.endsWith('/repositories'), 401, { detail: `bad key ${API_KEY} and Bearer ${API_KEY}` });
      const devinFailure = await h.run(['setup']);
      assert.equal(devinFailure.code, 1);
      assert.ok(!devinFailure.err.includes(API_KEY), devinFailure.err);
      assert.match(devinFailure.err, /\[redacted\]/);

      h.github.respondOnce((request) => request.route.startsWith('/repos/upstream/lib/'), {
        status: 401,
        body: { message: `Bad credentials ${TOKEN}` },
      });
      const githubFailure = await h.run(['mirror', 'upstream/lib#12']);
      assert.equal(githubFailure.code, 1);
      assert.ok(!githubFailure.err.includes(TOKEN), githubFailure.err);
    });
  });

  it('writes Knowledge notes only from configuration and recorded pitfalls, deferring to AGENTS.md', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.dir, 'setup/pitfalls.md'), '# Pitfalls\n\n- The e2e suite needs a display; run unit tests only.\n');
      assert.equal((await h.run(['setup'])).code, 0);
      const byName = new Map(h.devin.notes.map((note) => [note.name, note.body]));
      assert.ok(byName.get('Bug Smasher: fast tests')?.includes(CHECK));
      assert.ok(byName.get('Bug Smasher: verification image')?.includes(IMAGE));
      assert.match(byName.get('Bug Smasher: observed pitfalls') ?? '', /^- The e2e suite needs a display; run unit tests only\.$/m);
      for (const body of byName.values()) assert.match(body, /If this note and the repository's AGENTS\.md disagree, follow AGENTS\.md\./);
    });
    const empty = desiredNotes(TARGET, loadSettings({}), [], 'setup/pitfalls.md');
    assert.match(empty[0]?.body ?? '', /No test command is configured/);
    assert.match(empty[1]?.body ?? '', /No verification image is configured/);
    assert.match(empty[2]?.body ?? '', /No pitfalls have been recorded/);
    assert.deepEqual(desiredLabels(LABEL).map((label) => label.name), [LABEL.triage, LABEL.fix, LABEL.engineer, LABEL.feature]);
  });
});

describe('operator env-status', () => {
  it('reports a nested failed step even when the build reports success', async () => {
    await withHarness(async (h) => {
      h.devin.seedBuild(
        { build_id: 'build-old', created_at: 1 },
        '{"step":"clone","status":"success"}\n',
      );
      h.devin.seedBuild(
        { build_id: 'build-new', created_at: 2 },
        [
          '2026-01-01T00:00:00Z [setup] step clone acme/widgets: succeeded',
          '{"step":"acme/widgets","status":"success","steps":[{"step":"maintenance","status":"success","steps":[{"step":"npm ci","status":"failed","exit_code":1}]}]}',
          'npm ERR! code ERESOLVE',
          'step snapshot: done',
        ].join('\n'),
      );
      const result = await h.run(['env-status']);
      assert.equal(result.code, 1);
      assert.match(result.out, /Build build-new: Devin reports succeeded/);
      assert.match(result.out, /failed {2}acme\/widgets > maintenance > npm ci \(log line 2, exit code 1\)/);
      assert.match(result.out, /reports succeeded, but 1 nested step failed: acme\/widgets > maintenance > npm ci/);
      assert.equal(writeCount(h), 0);
      assert.ok(h.devin.calls.filter((call) => call.path.startsWith('/logs/')).every((call) => !call.authorized), 'presigned downloads carry no Devin credential');
    });
  });

  it('passes a clean build and never calls an unreadable log clean', async () => {
    await withHarness(async (h) => {
      h.devin.seedBuild({ build_id: 'build-1' }, 'step install: ok\nstep test > unit: passed\n');
      h.devin.seedBuild({ build_id: 'build-2' }, 'free text only\n');
      assert.equal((await h.run(['env-status', 'build-1'])).code, 0);
      const unknown = await h.run(['env-status', 'build-2']);
      assert.equal(unknown.code, 1);
      assert.match(unknown.out, /step results are unknown/);
    });
  });

  it('parses text and JSON steps, keeping the latest outcome and innermost failure', () => {
    const log = parseBuildLog(
      [
        'step setup > deps: running',
        'step setup > deps: failed exit code 2',
        '{"name":"lint","path":["setup"],"conclusion":"skipped"}',
        '{"step":"setup","status":"failed"}',
      ].join('\n'),
    );
    assert.deepEqual(
      log.steps.map((step) => [step.path.join(' > '), step.outcome, step.exitCode]),
      [
        ['setup > deps', 'failed', 2],
        ['setup > lint', 'skipped', null],
        ['setup', 'failed', null],
      ],
    );
    assert.deepEqual(failedSteps(log).map((step) => step.path.join(' > ')), ['setup > deps']);
  });

  it('prints step names without terminal control characters', async () => {
    await withHarness(async (h) => {
      h.devin.seedBuild({ build_id: 'build-1' }, 'step \u001b[31minstall\u001b]8;;https://evil.test\u0007: failed\n');
      const result = await h.run(['env-status']);
      assert.equal(result.code, 1);
      assert.match(result.out, /install/);
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(result.out));
    });
  });

  it('clears a failed exit code when the step later passes', () => {
    const log = parseBuildLog('step deps: failed exit code 3\nstep deps: passed\n');
    assert.deepEqual(log.steps.map((step) => [step.outcome, step.exitCode]), [['passed', null]]);
  });

  it('refuses a presigned download that redirects to plain http', async () => {
    const fetched: string[] = [];
    const client = new DevinSetupClient({
      apiKey: API_KEY,
      orgId: ORG_ID,
      fetch: async (url, init) => {
        fetched.push(url);
        assert.equal(init.redirect, 'manual');
        if (url.startsWith('https://files.devin.test/a')) return new Response(null, { status: 302, headers: { location: 'https://files.devin.test/b' } });
        if (url.startsWith('https://files.devin.test/b')) return new Response(null, { status: 302, headers: { location: 'http://files.devin.test/c' } });
        return new Response('leaked');
      },
    });
    await assert.rejects(client.fetchDownload('get-build-logs', { url: 'https://files.devin.test/a?X-Signature=s', expires_at: 1 }), /not https/);
    assert.deepEqual(fetched, ['https://files.devin.test/a?X-Signature=s', 'https://files.devin.test/b']);
  });

  it('downloads presigned links without the Devin key and refuses non-https links', async () => {
    const devin = new FakeDevinSetup(ORG_ID);
    const client = new DevinSetupClient({ apiKey: API_KEY, orgId: ORG_ID, fetch: devin.fetch });
    devin.seedBuild({ build_id: 'b' }, 'step a: ok');
    assert.equal(await client.fetchDownload('get-build-logs', await client.getBuildLogs('b')), 'step a: ok');
    assert.equal(devin.calls.at(-1)?.authorized, false);
    await assert.rejects(client.fetchDownload('get-build-logs', { url: 'http://files.devin.test/x?sig=1', expires_at: 1 }), /must use https/);
    await assert.rejects(client.fetchDownload('get-build-logs', { url: 'https://files.devin.test/logs/none?X-Signature=secret', expires_at: 1 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 404/);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  });
});

describe('operator mirror', () => {
  const SOURCE = { owner: 'upstream', name: 'lib' };

  function seedSource(h: Harness): void {
    h.github.seedForeignIssue(SOURCE, { number: 12, title: 'Parser drops trailing commas', body: 'Steps: parse "[1,]"', author: 'reporter' });
  }

  it('creates a target issue with source provenance and no labels', async () => {
    await withHarness(async (h) => {
      seedSource(h);
      const result = await h.run(['mirror', 'upstream/lib#12']);
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /Created acme\/widgets#1 .* from upstream\/lib#12, labels: none/);
      const issue = await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).getIssue(1);
      assert.equal(issue.title, 'Parser drops trailing commas');
      assert.deepEqual(issue.labels, []);
      assert.match(issue.body, /^> Mirrored from `upstream\/lib#12` \(opened on \d{4}-\d{2}-\d{2}\)\. /);
      assert.ok(!issue.body.includes('https://github.com/upstream/lib/issues/12'));
      assert.ok(!issue.body.includes('reporter'));
      assert.match(issue.body, /Steps: parse "\[1,\]"/);
      assert.match(issue.body, /<!-- bug-smasher mirror-of=upstream\/lib#12 -->/);
      const writes = h.github.writes();
      assert.deepEqual(writes.map((request) => `${request.method} ${request.route}`), ['POST issues']);
    });
  });

  for (const [flag, label] of [['--triage', LABEL.triage], ['--fix', LABEL.fix]] as const) {
    it(`${flag} adds the ${label} label`, async () => {
      await withHarness(async (h) => {
        seedSource(h);
        const result = await h.run(['mirror', 'upstream/lib#12', flag]);
        assert.equal(result.code, 0, result.err);
        const issue = await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).getIssue(1);
        assert.deepEqual(issue.labels, [label]);
      });
    });
  }

  it('identifies a repeated mirror as a duplicate and keeps the provenance', async () => {
    await withHarness(async (h) => {
      seedSource(h);
      assert.equal((await h.run(['mirror', 'upstream/lib#12'])).code, 0);
      const writes = h.github.writes().length;
      const again = await h.run(['mirror', 'Upstream/Lib#12', '--fix']);
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /Duplicate: upstream\/lib#12 is already mirrored as acme\/widgets#1/);
      assert.equal(h.github.writes().length, writes);
      const issue = await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).getIssue(1);
      assert.match(issue.body, /<!-- bug-smasher mirror-of=upstream\/lib#12 -->/);
      assert.deepEqual(issue.labels, []);
    });
  });

  it('plans the mirror in a dry run without writing', async () => {
    await withHarness(async (h) => {
      seedSource(h);
      const result = await h.run(['mirror', 'upstream/lib#12', '--triage', '--dry-run']);
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /Dry run: would create an issue in the target from upstream\/lib#12, titled "Parser drops trailing commas", labels: needs-triage/);
      assert.equal(h.github.writes().length, 0);
    });
  });

  it('puts mentions, issue URLs and issue references from the source text in code formatting', async () => {
    await withHarness(async (h) => {
      h.github.seedForeignIssue(SOURCE, {
        number: 12,
        title: 'Parser drops trailing commas',
        author: 'reporter',
        body: [
          'Reported with @someone, see https://github.com/upstream/lib/issues/7 and #123.',
          'Related: [the fix](https://github.com/upstream/lib/pull/9), upstream/other#4 and a@example.com.',
          '```',
          'log: @kept #1',
          '```',
        ].join('\n'),
      });
      const result = await h.run(['mirror', 'upstream/lib#12', '--fix']);
      assert.equal(result.code, 0, result.err);
      const issue = await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).getIssue(1);
      assert.match(
        issue.body,
        /Reported with `@someone`, see `https:\/\/github\.com\/upstream\/lib\/issues\/7` and `#123`\./,
      );
      assert.match(issue.body, /Related: the fix \(`https:\/\/github\.com\/upstream\/lib\/pull\/9`\), `upstream\/other#4` and a@example\.com\./);
      assert.match(issue.body, /```\nlog: @kept #1\n```/);
      assert.match(issue.body, /^> Mirrored from `upstream\/lib#12` \(opened on \d{4}-\d{2}-\d{2}\)\. /);
      assert.ok(!/\]\(https?:/.test(issue.body), 'no Markdown links remain');
      assert.ok(!issue.body.includes('@reporter'));
      assert.match(issue.body, /<!-- bug-smasher mirror-of=upstream\/lib#12 -->/);
      assert.deepEqual(issue.labels, [LABEL.fix]);
    });
  });

  it('prints in a dry run exactly the body a real run creates', async () => {
    await withHarness(async (h) => {
      h.github.seedForeignIssue(SOURCE, { number: 12, title: 'Parser drops trailing commas', body: 'Ping @someone about #123', author: 'reporter' });
      const planned = await h.run(['mirror', 'upstream/lib#12', '--dry-run']);
      assert.equal(planned.code, 0, planned.err);
      assert.equal(h.github.writes().length, 0);
      const created = await h.run(['mirror', 'upstream/lib#12']);
      assert.equal(created.code, 0, created.err);
      const issue = await new GitHubTracker({ repo: h.github.repo, token: TOKEN, baseUrl: h.github.baseUrl }).getIssue(1);
      assert.ok(issue.body.includes('Ping `@someone` about `#123`'));
      assert.equal(planned.out.split('\nBody:\n')[1], issue.body);
    });
  });

  it('rejects bad references, both flags, and the target as its own source', async () => {
    await withHarness(async (h) => {
      assert.equal((await h.run(['mirror', 'not-a-ref'])).code, 2);
      assert.equal((await h.run(['mirror', 'upstream/lib#12', '--triage', '--fix'])).code, 2);
      h.github.seedIssue({ title: 'own' });
      const self = await h.run(['mirror', 'acme/widgets#1']);
      assert.equal(self.code, 1);
      assert.match(self.err, /is the target repository/);
      assert.equal(h.github.writes().length, 0);
    });
  });
});

describe('operator report', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bug-smasher-report-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function report(store: string, env: Record<string, string> = {}, githubBaseUrl?: string): Promise<string> {
    const out = join(dir, 'RESULTS.md');
    const code = await runCommand(['report', '--store', store, '--out', out], {
      env,
      cwd: dir,
      out: () => {},
      err: (line) => assert.fail(line),
      ...(githubBaseUrl === undefined ? {} : { githubBaseUrl }),
    });
    assert.equal(code, 0);
    return readFile(out, 'utf8');
  }

  function values(text: string): string[] {
    return text
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith(FIGURE_HEADER) && !line.startsWith('| ---') && text.includes(FIGURE_HEADER))
      .filter((line) => !line.startsWith('| Issue |'))
      .map((line) => line.split(' | ')[1] ?? '');
  }

  it('writes no figures from an empty store, only No data and Unavailable', async () => {
    const text = await report(join(dir, 'empty.json'));
    assert.match(text, /The bug store has no records yet/);
    assert.match(text, /GITHUB_REPO is not set, so no records count as live outcomes/);
    assert.ok(text.indexOf('## Bugs') < text.indexOf('## Headline numbers'));
    assert.ok(text.indexOf('## Headline numbers') < text.indexOf('## Spend'));
    assert.match(text, /Read at: not read/);
    const shown = new Set(values(text));
    assert.deepEqual([...shown].sort(), ['No data', 'Unavailable']);
  });

  it('lists a row per record from the store before the headline numbers', async () => {
    const path = join(dir, 'bugs.json');
    const store = await BugStore.open(path);
    await store.update('acme/widgets#42', () => enroll([LABEL.triage]));
    const text = await report(path, { GITHUB_REPO: TARGET });
    const row = text.split('\n').find((line) => line.startsWith('| acme/widgets#42 |'));
    assert.equal(row, '| acme/widgets#42 | acme/widgets (live) | bug | queued | none | none | none | open (queued) |');
    assert.ok(text.indexOf(row) < text.indexOf('## Headline numbers'));
    assert.match(text, /Live bugs of acme\/widgets: 1 bugs, 0 feature requests/);
    assert.match(text, /\| Time to fix \(median\) \| Unavailable \|/, 'filing time needs GitHub');
  });

  it('reads GitHub for the target records and never writes the token', async () => {
    const github = await FakeGitHub.start({ token: TOKEN });
    try {
      const { number } = github.seedIssue({ title: 'Legend overlaps', labels: [LABEL.triage] });
      const path = join(dir, 'github.json');
      const store = await BugStore.open(path);
      await store.update(`${TARGET}#${number}`, () => new Bug(number, [LABEL.triage], new Date().toISOString()).record);
      const text = await report(path, { GITHUB_REPO: TARGET, GITHUB_TOKEN: TOKEN }, github.baseUrl);
      assert.match(text, /Sources: GitHub acme\/widgets, read \d{4}-/);
      assert.equal(text.includes(TOKEN), false);
      assert.equal(github.writes().length, 0, 'the report only reads');
    } finally {
      await github.close();
    }
  });

  it('keeps GitHub evidence for live records when a replay record is not on GitHub', async () => {
    const github = await FakeGitHub.start({ token: TOKEN });
    try {
      const { number } = github.seedIssue({ title: 'Legend overlaps', labels: [LABEL.triage] });
      const path = join(dir, 'live-with-replay.json');
      const replayPath = join(dir, 'replay.json');
      await (await BugStore.open(path)).update(`${TARGET}#${number}`, () => new Bug(number, [LABEL.triage], new Date().toISOString()).record);
      await (await BugStore.open(replayPath)).update(`${TARGET}#999`, () => new Bug(999, [LABEL.triage], new Date().toISOString()).record);
      const out = join(dir, 'RESULTS-replay.md');
      const code = await runCommand(['report', '--store', path, '--replay-store', replayPath, '--out', out], {
        env: { GITHUB_REPO: TARGET, GITHUB_TOKEN: TOKEN },
        cwd: dir,
        out: () => {},
        err: (line) => assert.fail(line),
        githubBaseUrl: github.baseUrl,
      });
      assert.equal(code, 0);
      const text = await readFile(out, 'utf8');
      assert.match(text, /Sources: GitHub acme\/widgets, read \d{4}-/);
      assert.match(text, /\| acme\/widgets#999 \| acme\/widgets \(replay\) \|/);
    } finally {
      await github.close();
    }
  });

  it('escapes HTML and link syntax from provider text', () => {
    const reason = '<img src=x onerror=alert(1)> [click](https://evil.example)';
    const metrics = calculateMetrics(metricsInput([], { evidence: { ...unavailableEvidence(), github: { status: 'unavailable', reason } } }));
    const text = renderResults(metrics, 'data/<b>bugs</b>.json');
    assert.equal(text.includes('<b>'), false);
    assert.ok(text.includes('data/&lt;b&gt;bugs&lt;/b&gt;.json'));
    assert.equal(text.includes('<img'), false);
    assert.equal(text.includes('[click]('), false);
    assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt; \\[click\\](https://evil.example)'));
  });

  it('shows every figure of the shared calculation with its own value and metadata', () => {
    const bugs = liveBugs();
    const metrics = calculateMetrics(
      metricsInput(recordSets(bugs), { settings: { ...NO_COST, acuPriceUsd: 2 }, evidence: fullEvidence(bugs) }),
    );
    const text = renderResults(metrics, 'data/bugs.json');
    const cell = (value: string): string => value.replace(/\|/g, '\\|');
    const figures: Figure[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        if ('display' in value && 'samples' in value && 'window' in value) figures.push(value as Figure);
        else Object.values(value).forEach(walk);
      }
    };
    walk(metrics);
    assert.ok(figures.length > 100, `found ${figures.length} figures`);
    for (const figure of figures) {
      const asRow = `| ${cell(figure.label)} | ${cell(figure.display)} |`;
      const asReference = `| ${cell(figure.label)}: ${cell(figure.display)} (samples ${figure.samples}; source: ${cell(figure.source)}) |`;
      assert.ok(text.includes(asRow) || text.includes(asReference), `${figure.id} (${figure.label}: ${figure.display}) is not rendered`);
      assert.ok(text.includes(cell(figure.source)), `${figure.id} source is not rendered`);
    }
    for (const row of metrics.rows) assert.ok(text.includes(`| ${row.key} | ${cell(row.cohort)} |`), row.key);
    assert.ok(text.indexOf('## Headline numbers') < text.indexOf('## Spend'));
    assert.match(text, /## Other cohorts/);
    assert.match(text, /Largest sessions:/);
  });
});

describe('operator run', () => {
  it('starts the service with no credentials', async () => {
    const service = await startService({ GITHUB_TOKEN: '', DEVIN_API_KEY: '', GITHUB_REPO: '', DEVIN_ORG_ID: '' }, ['src/operator/main.ts', 'run']);
    try {
      const response = await fetch(new URL('/api/health', service.baseUrl));
      assert.equal(response.status, 200);
      assert.match(service.output(), /Workflow polling is off until live settings are complete/);
    } finally {
      await service.stop();
    }
  });

  it('prints usage for an unknown command', async () => {
    const lines: string[] = [];
    assert.equal(await runCommand(['deploy'], { env: {}, cwd: repoRoot, out: () => {}, err: (line) => lines.push(line) }), 2);
    assert.match(lines.join('\n'), /Unknown command deploy[\s\S]*Usage:/);
  });
});
