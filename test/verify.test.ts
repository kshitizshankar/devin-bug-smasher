import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadSettings } from '../src/config/settings.ts';
import type { VerificationAttempt } from '../src/model/types.ts';
import { validateVerificationAttempt } from '../src/model/validate.ts';
import type { VerificationOutcome, VerificationRequest } from '../src/orchestrator/contracts.ts';
import { DockerRuntime } from '../src/verify/docker.ts';
import { GitRepository } from '../src/verify/git.ts';
import { testPathProblem } from '../src/verify/paths.ts';
import {
  CheckedVerifier,
  checkCommandProblems,
  verifierFromSettings,
  verifierSettingsProblems,
} from '../src/verify/verifier.ts';
import {
  ADD_TEST,
  BASE_FILES,
  CHECK_COMMAND,
  FIXED_MATH,
  NODE,
  verifyWorld,
  type VerifyWorld,
} from './helpers/verify.ts';

const ADD_TEST_PATH = 'test/add.test.mjs';
const DOUBLE_TEST = BASE_FILES['test/double.test.mjs']!;

function attemptOf(outcome: VerificationOutcome): Omit<VerificationAttempt, 'sessionId'> {
  assert.equal(outcome.status, 'completed');
  return outcome.attempt;
}

describe('independent verification against fixture repositories', () => {
  let world: VerifyWorld;
  beforeEach(async () => {
    world = await verifyWorld();
  });
  afterEach(async () => {
    await world.close();
  });

  function request(headSha: string, testFiles: string[] = [ADD_TEST_PATH], phase: VerificationRequest['phase'] = 'pre-merge'): VerificationRequest {
    return {
      bugKey: 'acme/widgets#1',
      phase,
      prNumber: 1,
      prUrl: 'https://github.com/acme/widgets/pull/1',
      headSha,
      baseSha: world.repo.base,
      testFiles,
    };
  }

  async function verifyHead(files: Record<string, string | null>, testFiles?: string[], verifier: CheckedVerifier = world.verifier) {
    const head = await world.repo.head('fix', files);
    return { head, attempt: attemptOf(await verifier.verify(request(head, testFiles))) };
  }

  it('V1: passes when the new test fails on base with a real assertion and passes on head', async () => {
    const { head, attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
    assert.equal(attempt.result, 'pass', attempt.reason);
    assert.equal(attempt.phase, 'pre-merge');
    assert.equal(attempt.baseSha, world.repo.base);
    assert.equal(attempt.headSha, head);
    assert.match(attempt.reason, /fail on base .*1 of 1 test\(s\) failed.* and pass on head/);
    assert.deepEqual(validateVerificationAttempt({ ...attempt, sessionId: null }, 'attempt'), []);

    const runs = attempt.evidence?.runs ?? [];
    assert.deepEqual(
      runs.map((run) => [run.role, run.step, run.sha, run.outcome]),
      [
        ['head', 'test', head, 'passed'],
        ['base', 'test', world.repo.base, 'failed'],
      ],
    );
    for (const run of runs) {
      assert.equal(run.command[0], NODE);
      assert.equal(run.command.at(-1), ADD_TEST_PATH);
      assert.ok(Date.parse(run.endedAt) >= Date.parse(run.startedAt));
    }
    assert.match(runs[1]!.outputTail, /AssertionError|Expected values to be strictly equal/);
    assert.match(attempt.outputTail, /--- head test/);
    assert.match(attempt.outputTail, /--- base test/);
    assert.equal(world.runtime.starts.length, 2);
    assert.equal(world.runtime.starts[0]!.image, 'fixture/test-image:1');
    assert.equal(world.runtime.starts[0]!.network, false);
  });

  it('V2: rejects a test that passes on both base and head', async () => {
    const passing = DOUBLE_TEST.replace("test('doubles negatives'", "test('doubles large', () => {\n  assert.equal(double(50), 100);\n});\n\ntest('doubles negatives'");
    const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, 'test/double.test.mjs': passing }, ['test/double.test.mjs']);
    assert.equal(attempt.result, 'fail');
    assert.match(attempt.reason, /pass on both base .* and head .*, so they do not detect the bug/);
  });

  it('V3: fails when the new test fails on head', async () => {
    const { attempt } = await verifyHead({ 'src/math.mjs': `${BASE_FILES['src/math.mjs']}// touched\n`, [ADD_TEST_PATH]: ADD_TEST });
    assert.equal(attempt.result, 'fail');
    assert.match(attempt.reason, /fail on head .*1 of 1 test\(s\) failed/);
    assert.deepEqual(attempt.evidence?.runs.map((run) => run.role), ['head']);
  });

  describe('V4: each diff violation fails verification on its own, before anything runs', () => {
    const fix = { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST };
    const cases: [string, Record<string, string | null>, RegExp][] = [
      ['a deleted test file', { 'test/double.test.mjs': null }, /test-removed in test\/double\.test\.mjs: test file deleted/],
      [
        'a deleted test function',
        { 'test/double.test.mjs': DOUBLE_TEST.replace(/\ntest\('doubles negatives'[\s\S]*$/, '\n') },
        /test-removed in test\/double\.test\.mjs: test\(s\) removed: doubles negatives/,
      ],
      [
        'an added skip marker',
        { 'test/double.test.mjs': DOUBLE_TEST.replace("test('doubles negatives'", "test.skip('doubles negatives'") },
        /test-disabled in test\/double\.test\.mjs: 1 skip, expected-failure or only marker/,
      ],
      [
        'an added only marker',
        { 'test/double.test.mjs': DOUBLE_TEST.replace("test('doubles',", "test.only('doubles',") },
        /test-disabled in test\/double\.test\.mjs/,
      ],
      [
        'fewer assertions in a changed test file',
        { 'test/double.test.mjs': DOUBLE_TEST.replace('  assert.equal(double(0), 0);\n', '') },
        /test-weakened in test\/double\.test\.mjs: assertions dropped from 3 to 2/,
      ],
      [
        'an added suppression comment',
        { 'src/math.mjs': FIXED_MATH.replace('export function add', '// eslint-disable-next-line\nexport function add') },
        /check-silenced in src\/math\.mjs: 1 suppression comment/,
      ],
      ['a changed CI workflow', { '.github/workflows/ci.yml': 'on: push\njobs: { skip: {} }\n' }, /rules-changed in \.github\/workflows\/ci\.yml/],
      ['an added pytest.ini', { 'pytest.ini': '[pytest]\naddopts = -k "not slow"\n' }, /rules-changed in pytest\.ini/],
      [
        'changed package.json scripts',
        { 'package.json': '{ "name": "fixture", "type": "module", "scripts": { "test": "exit 0" } }\n' },
        /rules-changed in package\.json: scripts or test, lint or type-check configuration changed/,
      ],
    ];
    for (const [name, change, reason] of cases) {
      it(`rejects ${name}`, async () => {
        const { attempt } = await verifyHead({ ...fix, ...change });
        assert.equal(attempt.result, 'fail');
        assert.match(attempt.reason, /^Diff checks failed: /);
        assert.match(attempt.reason, reason);
        assert.equal(attempt.evidence?.violations.length, 1, attempt.reason);
        assert.equal(world.runtime.starts.length, 0);
      });
    }
  });

  it('V4: flags, but does not fail, a change outside tests that only deletes lines', async () => {
    const guardTest = ADD_TEST.replace("assert.equal(add(1, 2), 3);", 'assert.equal(add(2000, 0), 2000);');
    const { attempt } = await verifyHead({
      'src/math.mjs': BASE_FILES['src/math.mjs']!.replace('  if (a > 1000) return 0;\n', ''),
      [ADD_TEST_PATH]: guardTest,
    });
    assert.equal(attempt.result, 'pass', attempt.reason);
    assert.deepEqual(attempt.evidence?.violations, []);
    assert.deepEqual(attempt.evidence?.flags.map((flag) => flag.check), ['deletion-only']);
    assert.match(attempt.reason, /flagged for review: deletion-only/);
  });

  describe('V5: infrastructure problems are errors, never failed proofs', () => {
    it('reports a dependency setup failure separately from test results', async () => {
      await world.close();
      world = await verifyWorld({ setupCommand: `${NODE} -e process.exit(3)` });
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /^Head [0-9a-f]{12}: setup failed with exit code 3$/);
      assert.deepEqual(attempt.evidence?.runs.map((run) => [run.step, run.outcome]), [['setup', 'error']]);
      assert.equal(world.runtime.starts[0]!.network, true);
    });

    it('treats a missing module on base as an error, not as the bug being detected', async () => {
      const helperTest = ADD_TEST.replace("import { add } from '../src/math.mjs';", "import { add } from '../src/sum.mjs';");
      const { attempt } = await verifyHead({ 'src/sum.mjs': 'export const add = (a, b) => a + b;\n', [ADD_TEST_PATH]: helperTest });
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /^Base [0-9a-f]{12}: an import or dependency is missing/);
    });

    it('treats a timeout as an error', async () => {
      await world.close();
      world = await verifyWorld({ timeoutSeconds: 2 });
      const hang = "import test from 'node:test';\ntest('hangs', () => { for (;;) {} });\n";
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: hang });
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /timed out after 2 s/);
    });

    it('treats a test file that crashes outside any test as an error', async () => {
      const crash = `${ADD_TEST}process.kill(process.pid, 'SIGKILL');\n`;
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: crash });
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /failed to load or crashed outside any test/);
    });

    it('treats a crashed test runner as an error', async () => {
      await world.close();
      world = await verifyWorld({ checkCommand: `${NODE} -e process.kill(process.pid,'SIGKILL') {results} {files}` });
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /the test run crashed \(signal SIGKILL\)/);
    });

    it('treats missing and unreadable results as errors', async () => {
      for (const [command, reason] of [
        [`${NODE} -e 0 {results} {files}`, /no JUnit report was written/],
        [`${NODE} -e require('fs').writeFileSync(process.argv[1],'garbage') {results} {files}`, /the report is not JUnit XML/],
        [`${NODE} -e require('fs').symlinkSync('/etc/hostname',process.argv[1]) {results} {files}`, /no JUnit report was written/],
      ] as const) {
        await world.close();
        world = await verifyWorld({ checkCommand: command });
        const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
        assert.equal(attempt.result, 'error');
        assert.match(attempt.reason, reason);
      }
    });

    it('replaces a link in the base tree with the new test instead of writing through it', async () => {
      const outside = join(world.root, 'outside.txt');
      await writeFile(outside, 'untouched\n');
      const base = await world.repo.advanceMainWithLink(ADD_TEST_PATH, outside);
      const head = await world.repo.head('fix', { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST }, base);
      const attempt = attemptOf(await world.verifier.verify({ ...request(head), baseSha: base }));
      assert.equal(await readFile(outside, 'utf8'), 'untouched\n');
      assert.equal(attempt.result, 'pass', attempt.reason);
    });

    it('treats commits that cannot be fetched as an error', async () => {
      const outcome = await world.verifier.verify(request('0'.repeat(40)));
      const attempt = attemptOf(outcome);
      assert.equal(attempt.result, 'error');
      assert.match(attempt.reason, /^Could not prepare the commits: /);
    });
  });

  describe('V6: selected test paths are validated before anything runs', () => {
    const unsafe = [
      '../outside.test.mjs',
      'test/../../outside.test.mjs',
      '/etc/passwd',
      'test/add.test.mjs;touch pwned',
      '$(touch pwned).test.mjs',
      'test/add.test.mjs && touch pwned',
      'test/*.test.mjs',
      'test/add.test.mjs::adds',
      '--require=./pwned.mjs',
      '.git/config',
    ];
    for (const path of unsafe) {
      it(`rejects ${JSON.stringify(path)}`, async () => {
        const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST }, [path]);
        assert.equal(attempt.result, 'fail');
        assert.match(attempt.reason, /^Rejected test path\(s\): .*; nothing was run$/);
        assert.equal(world.runtime.starts.length, 0);
        assert.equal(existsSync(join(world.repo.dir, 'pwned')), false);
      });
    }

    it('rejects files that are not tests or that the pull request did not change', async () => {
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST }, ['src/math.mjs', 'test/double.test.mjs']);
      assert.equal(attempt.result, 'fail');
      assert.match(attempt.reason, /"src\/math\.mjs" is not a test file/);
      assert.match(attempt.reason, /"test\/double\.test\.mjs" is not added or changed by the pull request/);
      assert.equal(world.runtime.starts.length, 0);
    });

    it('rejects an empty selection', async () => {
      const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST }, []);
      assert.equal(attempt.result, 'fail');
      assert.match(attempt.reason, /No test files were selected/);
    });

    it('accepts ordinary nested test paths', () => {
      for (const path of ['test/add.test.mjs', 'tests/unit/test_math.py', 'pkg/math_test.go', 'src/__tests__/Add.spec.tsx']) {
        assert.equal(testPathProblem(path), null, path);
      }
    });
  });

  it('G7: never runs a command proposed in the pull request; only the configured runner runs', async () => {
    const script = `touch ${join(world.root, 'pwned')}`;
    const { attempt } = await verifyHead({
      'src/math.mjs': FIXED_MATH,
      [ADD_TEST_PATH]: `${ADD_TEST}// To reproduce run: ${script}\n`,
      'scripts/repro.sh': `#!/bin/sh\n${script}\n`,
    });
    assert.equal(attempt.result, 'pass', attempt.reason);
    assert.equal(existsSync(join(world.root, 'pwned')), false);
    const configured = CHECK_COMMAND.split(' ').slice(0, 5);
    for (const argv of world.runtime.commands) assert.deepEqual(argv.slice(0, 5), configured);
  });

  it('G9: keeps configured secrets out of recorded output, reasons and commands', async () => {
    const secret = 'ghp_fixtureSECRET123456';
    await world.close();
    world = await verifyWorld({ secrets: [secret] });
    const leaky = ADD_TEST.replace("test('adds'", `console.log('token ${secret}');\ntest('adds'`);
    const { attempt } = await verifyHead({ 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: leaky });
    assert.equal(attempt.result, 'pass', attempt.reason);
    assert.ok(!JSON.stringify(attempt).includes(secret));
    assert.match(JSON.stringify(attempt), /\[redacted\]/);
    for (const env of world.runtime.envs) assert.deepEqual(Object.keys(env), ['PATH']);
  });

  it('verifies a merge commit against its first parent', async () => {
    await world.repo.head('fix', { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
    const mainHead = await world.repo.advanceMain({ 'README.md': 'docs\n' });
    const merge = await world.repo.merge('fix');
    const attempt = attemptOf(await world.verifier.verify(request(merge, [ADD_TEST_PATH], 'post-merge')));
    assert.equal(attempt.result, 'pass', attempt.reason);
    assert.equal(attempt.phase, 'post-merge');
    assert.equal(attempt.headSha, merge);
    assert.equal(attempt.baseSha, mainHead);
  });

  it('fails post-merge verification when the merged result no longer fixes the bug', async () => {
    await world.repo.head('fix', { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
    const merge = await world.repo.merge('fix', { 'src/math.mjs': BASE_FILES['src/math.mjs']! });
    const attempt = attemptOf(await world.verifier.verify(request(merge, [ADD_TEST_PATH], 'post-merge')));
    assert.equal(attempt.result, 'fail');
    assert.match(attempt.reason, /fail on head/);
  });
});

describe('verifier configuration', () => {
  it('requires {files} and {results} in the check command', () => {
    assert.deepEqual(checkCommandProblems('npm test -- {files} --reporter-output={results}'), []);
    assert.equal(checkCommandProblems('npm test').length, 2);
    assert.equal(checkCommandProblems(null).length, 1);
  });

  it('keeps the live verifier off until the repository, image and check command are configured', () => {
    const missing = verifierSettingsProblems(loadSettings({}));
    assert.equal(missing.length, 3);
    assert.throws(() => verifierFromSettings(loadSettings({})), /Verification settings are incomplete/);
    const settings = loadSettings({
      GITHUB_REPO: 'acme/widgets',
      VERIFY_IMAGE: 'node:22.18.0-alpine',
      CHECK_COMMAND: 'node --test --test-reporter=junit --test-reporter-destination={results} {files}',
    });
    assert.deepEqual(verifierSettingsProblems(settings), []);
    assert.equal(verifierFromSettings(settings).live, true);
  });
});

describe('Docker runtime', () => {
  it('G9: passes no service environment or credentials to Docker or the container, and cuts the network before tests', async (t) => {
    const world = await verifyWorld();
    t.after(() => world.close());
    const log = join(world.root, 'docker.log');
    const fake = join(world.root, 'docker');
    await writeFile(
      fake,
      [
        `#!${NODE}`,
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');`,
        "if (process.argv[2] === 'run') console.log('container-id');",
        '',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    const secretEnv = { ...process.env, GITHUB_TOKEN: 'ghp_hostSECRET', DEVIN_API_KEY: 'apk_hostSECRET' };
    const head = await world.repo.head('fix', { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: ADD_TEST });
    const verifier = new CheckedVerifier({
      repository: new GitRepository({ remote: world.repo.dir, dir: join(world.root, 'docker-mirror.git') }),
      runtime: new DockerRuntime({ docker: fake, env: secretEnv }),
      image: 'fixture/test-image:1',
      checkCommand: 'node --test {files} --test-reporter=junit --test-reporter-destination={results}',
      setupCommand: 'npm ci',
      timeoutSeconds: 20,
      workDir: join(world.root, 'docker-runs'),
    });
    const attempt = attemptOf(
      await verifier.verify({ bugKey: 'acme/widgets#1', phase: 'pre-merge', prNumber: 1, prUrl: 'https://github.com/acme/widgets/pull/1', headSha: head, baseSha: world.repo.base, testFiles: [ADD_TEST_PATH] }),
    );
    assert.equal(attempt.result, 'error');
    assert.match(attempt.reason, /no JUnit report was written/);

    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
    const text = JSON.stringify(calls);
    assert.ok(!text.includes('ghp_hostSECRET') && !text.includes('apk_hostSECRET'));
    for (const call of calls) {
      assert.ok(!('GITHUB_TOKEN' in call.env) && !('DEVIN_API_KEY' in call.env));
      assert.ok(!call.argv.some((arg) => arg === '-e' || arg.startsWith('--env')), call.argv.join(' '));
    }
    const verbs = calls.map((call) => (call.argv[0] === 'exec' ? `exec ${call.argv.slice(2).join(' ')}` : call.argv.slice(0, 3).join(' ')));
    assert.match(verbs[0]!, /^run --detach --name$/);
    const run = calls[0]!.argv;
    assert.equal(run[run.indexOf('--network') + 1], 'bridge');
    assert.ok(run.includes('fixture/test-image:1'));
    const setup = verbs.indexOf('exec npm ci');
    const disconnect = verbs.findIndex((verb) => verb.startsWith('network disconnect'));
    const tests = verbs.findIndex((verb) => verb.startsWith('exec node --test test/add.test.mjs'));
    assert.ok(setup >= 0 && setup < disconnect && disconnect < tests, verbs.join('\n'));
    assert.ok(verbs.some((verb) => verb.startsWith('rm --force')));
  });

  const image = process.env.VERIFY_DOCKER_IMAGE;
  it('runs a real proof in Docker when VERIFY_DOCKER_IMAGE is set', { skip: image === undefined ? 'set VERIFY_DOCKER_IMAGE (e.g. node:22.18.0-alpine) to run' : false }, async (t) => {
    const world = await verifyWorld();
    t.after(() => world.close());
    const envTest = ADD_TEST.replace("test('adds'", "test('sees no service credentials', () => {\n  assert.equal(process.env.GITHUB_TOKEN, undefined);\n  assert.equal(process.env.DEVIN_API_KEY, undefined);\n});\n\ntest('adds'");
    const head = await world.repo.head('fix', { 'src/math.mjs': FIXED_MATH, [ADD_TEST_PATH]: envTest });
    const verifier = new CheckedVerifier({
      repository: new GitRepository({ remote: world.repo.dir, dir: join(world.root, 'docker-mirror.git') }),
      runtime: new DockerRuntime({ env: { ...process.env, GITHUB_TOKEN: 'ghp_hostSECRET', DEVIN_API_KEY: 'apk_hostSECRET' } }),
      image: image ?? '',
      checkCommand: 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={results} {files}',
      setupCommand: null,
      timeoutSeconds: 120,
      workDir: join(world.root, 'docker-runs'),
    });
    const attempt = attemptOf(
      await verifier.verify({ bugKey: 'acme/widgets#1', phase: 'pre-merge', prNumber: 1, prUrl: 'https://github.com/acme/widgets/pull/1', headSha: head, baseSha: world.repo.base, testFiles: [ADD_TEST_PATH] }),
    );
    assert.equal(attempt.result, 'pass', `${attempt.reason}\n${attempt.outputTail}`);
    assert.match(attempt.reason, /1 of 2 test\(s\) failed/);
  });
});
