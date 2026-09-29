import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BugRecord } from '../model/types.ts';
import { validateBugRecord } from '../model/validate.ts';

export const SCHEMA_VERSION = 1;

export const DEFAULT_BUG_STORE_PATH = fileURLToPath(new URL('../../data/bugs.json', import.meta.url));

export interface BugStoreFile {
  schemaVersion: typeof SCHEMA_VERSION;
  bugs: Record<string, BugRecord>;
}

export type BugStoreErrorCode = 'read-failed' | 'corrupt' | 'unsupported-schema' | 'invalid-record' | 'write-failed';

export class BugStoreError extends Error {
  readonly code: BugStoreErrorCode;
  readonly path: string;

  constructor(code: BugStoreErrorCode, path: string, message: string, options?: { cause?: unknown }) {
    super(`${message} (${path})`, options);
    this.name = 'BugStoreError';
    this.code = code;
    this.path = path;
  }
}

/** `undefined` leaves the record unchanged and skips the write. */
export type BugUpdater = (current: BugRecord | undefined) => BugRecord | undefined;

const MAX_REPORTED_PROBLEMS = 10;

function parseStoreFile(path: string, text: string): Map<string, BugRecord> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BugStoreError('corrupt', path, 'Bug store is not valid JSON; refusing to reset it', { cause: error });
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new BugStoreError('corrupt', path, 'Bug store must be a JSON object; refusing to reset it');
  }
  const file = data as Record<string, unknown>;
  if (file.schemaVersion !== SCHEMA_VERSION) {
    throw new BugStoreError(
      'unsupported-schema',
      path,
      `Unsupported bug store schemaVersion ${JSON.stringify(file.schemaVersion)} (expected ${SCHEMA_VERSION})`,
    );
  }
  const bugs = file.bugs;
  if (typeof bugs !== 'object' || bugs === null || Array.isArray(bugs)) {
    throw new BugStoreError('corrupt', path, 'Bug store "bugs" must be an object keyed by owner/repo#number');
  }
  const problems: string[] = [];
  const records = new Map<string, BugRecord>();
  for (const [key, value] of Object.entries(bugs as Record<string, unknown>)) {
    const recordProblems = validateBugRecord(value, `bugs[${JSON.stringify(key)}]`);
    const recordKey = (value as { key?: unknown } | null)?.key;
    if (recordProblems.length === 0 && recordKey !== key) {
      recordProblems.push(`bugs[${JSON.stringify(key)}].key does not match its map key`);
    }
    problems.push(...recordProblems);
    if (recordProblems.length === 0) records.set(key, value as BugRecord);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
    const more = problems.length > shown.length ? `; and ${problems.length - shown.length} more` : '';
    throw new BugStoreError('invalid-record', path, `Bug store has invalid records: ${shown.join('; ')}${more}`);
  }
  return records;
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new BugStoreError('write-failed', path, 'Failed to write bug store; the previous file is unchanged', {
      cause: error,
    });
  }
}

/**
 * JSON-file store for bug records, keyed by `owner/repo#number`. Writes replace the file atomically
 * (temporary file + rename) and are serialized within the process, so overlapping updates are not lost.
 * In-memory state only changes after a successful write.
 */
const openStores = new Map<string, Promise<BugStore>>();

/**
 * Reads a store file's records without opening (or caching) a `BugStore`: for readers that must see the
 * file as it is now, such as a service following a store another process writes. A missing file is empty.
 */
export async function readBugRecords(path: string): Promise<BugRecord[]> {
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new BugStoreError('read-failed', absolute, 'Failed to read bug store', { cause: error });
  }
  const records = parseStoreFile(absolute, text);
  return [...records.keys()].sort().map((key) => records.get(key) as BugRecord);
}

export class BugStore {
  readonly path: string;
  #records: Map<string, BugRecord>;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, records: Map<string, BugRecord>) {
    this.path = path;
    this.#records = records;
  }

  /**
   * Loads the store. A missing file is an empty store; unreadable or invalid data throws `BugStoreError`.
   * Within one process every `open` of the same resolved path returns the same instance, so all callers
   * share one snapshot and one write queue. Multi-process access is not supported.
   */
  static open(path: string = DEFAULT_BUG_STORE_PATH): Promise<BugStore> {
    const absolute = resolve(path);
    const existing = openStores.get(absolute);
    if (existing !== undefined) return existing;
    const loading = BugStore.#load(absolute);
    openStores.set(absolute, loading);
    loading.catch(() => openStores.delete(absolute));
    return loading;
  }

  static async #load(absolute: string): Promise<BugStore> {
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new BugStore(absolute, new Map());
      throw new BugStoreError('read-failed', absolute, 'Failed to read bug store', { cause: error });
    }
    return new BugStore(absolute, parseStoreFile(absolute, text));
  }

  get(key: string): BugRecord | undefined {
    const record = this.#records.get(key);
    return record === undefined ? undefined : structuredClone(record);
  }

  list(): BugRecord[] {
    return [...this.#records.keys()].sort().map((key) => structuredClone(this.#records.get(key) as BugRecord));
  }

  /**
   * Runs `updater` against the latest committed record for `key` (after earlier queued updates) and
   * persists its result. Rejects with `BugStoreError` if the result is invalid or the write fails; the
   * file and in-memory state then keep their previous values.
   */
  update(key: string, updater: BugUpdater): Promise<BugRecord | undefined> {
    const run = this.#queue.then(() => this.#applyUpdate(key, updater));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #applyUpdate(key: string, updater: BugUpdater): Promise<BugRecord | undefined> {
    const next = updater(this.get(key));
    if (next === undefined) return this.get(key);

    const problems = validateBugRecord(next);
    if (problems.length === 0 && next.key !== key) problems.push(`record.key ${next.key} does not match ${key}`);
    if (problems.length > 0) {
      throw new BugStoreError('invalid-record', this.path, `Refusing to store invalid record: ${problems.join('; ')}`);
    }

    const records = new Map(this.#records);
    records.set(key, structuredClone(next));
    const file: BugStoreFile = {
      schemaVersion: SCHEMA_VERSION,
      bugs: Object.fromEntries([...records.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    await writeAtomically(this.path, `${JSON.stringify(file, null, 2)}\n`);
    this.#records = records;
    return structuredClone(next);
  }
}
