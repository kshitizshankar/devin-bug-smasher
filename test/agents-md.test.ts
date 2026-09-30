import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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

