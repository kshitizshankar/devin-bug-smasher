import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PLAYBOOK_ROUTES, playbookTitle } from '../src/orchestrator/playbooks.ts';
import { repoRoot } from './helpers/service.ts';

/** Devin loads only the first 16 KiB of AGENTS.md automatically. */
const AGENTS_MD_LIMIT = 16_384;

describe('AGENTS.md', () => {
  it('stays under the automatic 16 KiB load with its critical rules and without the stale feature-label sentence', async () => {
    const bytes = await readFile(join(repoRoot, 'AGENTS.md'));
    assert.ok(bytes.length < AGENTS_MD_LIMIT, `AGENTS.md is ${bytes.length} bytes`);
    const loaded = bytes.subarray(0, AGENTS_MD_LIMIT).toString('utf8');
    assert.match(loaded, /Work only on the issue you were assigned/);
    assert.match(loaded, /Devin must never merge a pull request itself/);
    assert.match(loaded, /npm run typecheck/);
    assert.doesNotMatch(loaded, /does not launch any implemented\s+automation/);
    assert.match(loaded, /`devin-builds-feature` label starts a feature session/);
  });
});

describe('How the service talks to Devin', () => {
  it('documents every prompt file, every route Playbook title and the attach-or-inline rule', async () => {
    const page = await readFile(join(repoRoot, 'docs/DEVIN-PROMPTS.md'), 'utf8');
    assert.match(page, /^# How the service talks to Devin$/m);
    for (const file of (await readdir(join(repoRoot, 'prompts'))).filter((name) => name.endsWith('.md') && name !== 'README.md')) {
      if (file === 'post-merge-ack.md') continue;
      assert.ok(page.includes(file), `the page mentions prompts/${file}`);
    }
    for (const route of PLAYBOOK_ROUTES) {
      assert.ok(playbookTitle('<owner>/<repo>', route).startsWith(`Bug Smasher ${route}:`));
      assert.ok(page.includes(`\`${route}\``), `the page names the ${route} route`);
    }
    assert.match(page, /Bug Smasher <route>: <owner>\/<repo>/);
    assert.match(page, /A session never receives both/);
    assert.match(page, /exactly once/);
  });
});
