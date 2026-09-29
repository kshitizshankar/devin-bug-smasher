import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BugStore, BugStoreError, SCHEMA_VERSION } from '../src/store/bug-store.ts';
import { enroll, LABEL, now } from './helpers/model.ts';
import { repoRoot } from './helpers/service.ts';

const KEY = 'acme/widgets#42';

function withDecision(actor: string) {
  return (current: ReturnType<BugStore['get']>) => {
    const record = current ?? enroll([LABEL.triage]);
    record.decisions.push({ action: 'triage', outcome: 'applied', actor, at: now(), context: null });
    return record;
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<BugStoreError> {
  let caught: unknown;
  await promise.catch((error: unknown) => {
    caught = error;
  });
  assert.ok(caught instanceof BugStoreError, `expected BugStoreError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

describe('JSON bug store', () => {
  let dir: string;
  let counter = 0;
  const freshPath = async (): Promise<string> => {
    counter += 1;
    const sub = join(dir, `case-${counter}`);
    await mkdir(sub);
    return join(sub, 'data', 'bugs.json');
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bug-smasher-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as an empty store and creates it on first write', async () => {
    const path = await freshPath();
    const store = await BugStore.open(path);
    assert.deepEqual(store.list(), []);
    await store.update(KEY, withDecision('ana'));
    const file = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(file.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(Object.keys(file.bugs), [KEY]);
  });

  it('retains records across a restart in a separate process', async () => {
    const path = await freshPath();
    const script = [
      "import { BugStore } from './src/store/bug-store.ts';",
      "import { enroll, LABEL } from './test/helpers/model.ts';",
      `const store = await BugStore.open(${JSON.stringify(path)});`,
      `await store.update(${JSON.stringify(KEY)}, () => enroll([LABEL.fix]));`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repoRoot, stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);

    const reopened = await BugStore.open(path);
    const record = reopened.get(KEY);
    assert.equal(record?.stage, 'queued');
    assert.equal(record?.route, 'fix');
  });

  it('serializes overlapping updates so none are lost', async () => {
    const path = await freshPath();
    const store = await BugStore.open(path);
    const actors = Array.from({ length: 25 }, (_, index) => `person-${index}`);
    await Promise.all([
      ...actors.map((actor) => store.update(KEY, withDecision(actor))),
      store.update('acme/widgets#43', () => ({ ...enroll([LABEL.triage]), key: 'acme/widgets#43' })),
    ]);

    const reopened = await BugStore.open(path);
    assert.deepEqual(
      reopened.get(KEY)?.decisions.map((decision) => decision.actor),
      actors,
      'every update applied in call order',
    );
    assert.deepEqual(reopened.list().map((record) => record.key), [KEY, 'acme/widgets#43']);
    const leftovers = (await readdir(join(path, '..'))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('keeps later updates working after one update fails', async () => {
    const store = await BugStore.open(await freshPath());
    const failing = store.update(KEY, () => {
      throw new Error('boom');
    });
    const next = store.update(KEY, withDecision('ana'));
    await assert.rejects(failing, /boom/);
    assert.equal((await next)?.decisions.length, 1);
  });

  it('refuses malformed JSON without touching the file', async () => {
    const path = await freshPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{"schemaVersion": 1, "bugs": {');
    const error = await rejectsWith(BugStore.open(path), 'corrupt');
    assert.match(error.message, /refusing to reset/);
    assert.equal(await readFile(path, 'utf8'), '{"schemaVersion": 1, "bugs": {');
  });

  it('refuses an unknown schema version and invalid records', async () => {
    const path = await freshPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 99, bugs: {} }));
    await rejectsWith(BugStore.open(path), 'unsupported-schema');

    const record = { ...enroll([LABEL.triage]), stage: 'fixed' };
    const invalid = JSON.stringify({ schemaVersion: SCHEMA_VERSION, bugs: { [KEY]: record } });
    await writeFile(path, invalid);
    const error = await rejectsWith(BugStore.open(path), 'invalid-record');
    assert.match(error.message, /stage must be one of/);
    assert.equal(await readFile(path, 'utf8'), invalid);

    const mismatched = JSON.stringify({ schemaVersion: SCHEMA_VERSION, bugs: { 'acme/widgets#1': enroll([LABEL.fix]) } });
    await writeFile(path, mismatched);
    await rejectsWith(BugStore.open(path), 'invalid-record');
  });

  it('refuses to store an invalid record and keeps the previous state', async () => {
    const path = await freshPath();
    const store = await BugStore.open(path);
    await store.update(KEY, withDecision('ana'));
    const before = await readFile(path, 'utf8');

    await rejectsWith(
      store.update(KEY, (current) => ({ ...(current as NonNullable<typeof current>), stage: 'fixed' as 'fixing' })),
      'invalid-record',
    );
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(store.get(KEY)?.stage, 'queued');
  });

  it('surfaces a failed write and preserves the prior valid file and in-memory state', async (t) => {
    const path = await freshPath();
    const store = await BugStore.open(path);
    await store.update(KEY, withDecision('ana'));
    const before = await readFile(path, 'utf8');
    const dataDir = join(path, '..');

    await chmod(dataDir, 0o500);
    try {
      const writable = await access(dataDir, constants.W_OK).then(
        () => true,
        () => false,
      );
      if (writable) {
        t.skip('running with elevated file access: a read-only directory is still writable');
        return;
      }
      const error = await rejectsWith(store.update(KEY, withDecision('bob')), 'write-failed');
      assert.match(error.message, /previous file is unchanged/);
      assert.ok(error.cause instanceof Error);
    } finally {
      await chmod(dataDir, 0o700);
    }

    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(store.get(KEY)?.decisions.map((decision) => decision.actor), ['ana']);
    const reopened = await BugStore.open(path);
    assert.deepEqual(reopened.get(KEY)?.decisions.map((decision) => decision.actor), ['ana']);
    await store.update(KEY, withDecision('carol'));
    assert.deepEqual(store.get(KEY)?.decisions.map((decision) => decision.actor), ['ana', 'carol']);
  });

  it('shares one instance per path within the process so separate handles cannot lose records', async () => {
    const path = await freshPath();
    const [first, second] = await Promise.all([BugStore.open(path), BugStore.open(path)]);
    assert.equal(first, second);
    assert.equal(await BugStore.open(join(path, '..', '.', 'bugs.json')), first, 'paths are resolved');
    assert.notEqual(await BugStore.open(await freshPath()), first);

    await Promise.all([
      first.update(KEY, withDecision('ana')),
      second.update('acme/widgets#43', () => ({ ...enroll([LABEL.triage]), key: 'acme/widgets#43' })),
      second.update(KEY, withDecision('bob')),
    ]);
    const file = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(file.bugs), [KEY, 'acme/widgets#43']);
    assert.deepEqual(file.bugs[KEY].decisions.map((decision: { actor: string }) => decision.actor), ['ana', 'bob']);
  });

  it('does not cache a store that failed to open', async () => {
    const path = await freshPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'not json');
    await rejectsWith(BugStore.open(path), 'corrupt');
    await writeFile(path, JSON.stringify({ schemaVersion: SCHEMA_VERSION, bugs: {} }));
    assert.deepEqual((await BugStore.open(path)).list(), []);
  });

  it('returns copies so callers cannot mutate stored state', async () => {
    const store = await BugStore.open(await freshPath());
    await store.update(KEY, withDecision('ana'));
    const copy = store.get(KEY);
    copy?.decisions.push({ action: 'close', outcome: 'applied', actor: 'mallory', at: now(), context: null });
    assert.equal(store.get(KEY)?.decisions.length, 1);
  });
});
