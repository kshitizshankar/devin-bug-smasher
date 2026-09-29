import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadSettings } from '../src/config/settings.ts';
import { verifyCheck } from '../src/operator/verify-check.ts';
import { DockerRuntime } from '../src/verify/docker.ts';
import { CHECK_COMMAND, LocalRuntime } from './helpers/verify.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

/** Top-level keys of an indented YAML mapping block (two-space indentation). */
function childKeys(yaml: string, parent: string, indent: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `${parent}:` || line.trimEnd() === `${indent.slice(2)}${parent.trim()}:`);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(indent)) break;
    const match = new RegExp(`^${indent}([A-Za-z0-9_-]+):`).exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

describe('Docker packaging', () => {
  it('compose defines one service, published on the host loopback only', async () => {
    const compose = await read('compose.yaml');
    assert.deepEqual(childKeys(compose, 'services', '  '), ['bug-smasher']);
    const ports = [...compose.matchAll(/^\s+- "([^"]+)"$/gm)].map((match) => match[1]);
    assert.deepEqual(ports, ['127.0.0.1:${BUG_SMASHER_PORT:-8080}:8080']);
    assert.doesNotMatch(compose, /network_mode:\s*host|privileged:\s*true|expose:/);
  });

  it('compose mounts data, the Docker socket and the verification workspace at the same absolute path', async () => {
    const compose = await read('compose.yaml');
    assert.match(compose, /- bug-smasher-data:\/app\/data/);
    assert.match(compose, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
    const source = /source: (\S+)/.exec(compose)?.[1];
    const target = /target: (\S+)/.exec(compose)?.[1];
    assert.ok(source);
    assert.equal(target, source);
    assert.match(compose, new RegExp(`VERIFY_WORK_DIR: ${source.replace(/[$(){}*+?.\\-]/g, '\\$&')}`));
    assert.match(compose, /BUG_SMASHER_CONTAINER: "true"/);
    assert.match(compose, /required: false/, 'starts without a .env file');
  });

  it('the image builds the frontend in a separate stage and ships Node 22+, git and the Docker client', async () => {
    const dockerfile = await read('Dockerfile');
    const stages = [...dockerfile.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)].map((match) => match[2]);
    assert.deepEqual(stages, ['docker-cli', 'build', 'runtime']);
    const node = /ARG NODE_IMAGE=node:(\d+)\.(\d+)/.exec(dockerfile);
    assert.ok(node && (Number(node[1]) > 22 || (Number(node[1]) === 22 && Number(node[2]) >= 18)));
    assert.match(dockerfile, /RUN npm run build/);
    assert.match(dockerfile, /apt-get install[^\n]*\bgit\b/);
    assert.match(dockerfile, /COPY --from=docker-cli \/usr\/local\/bin\/docker/);
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    assert.match(runtime, /COPY --from=build \/build\/dist\/web \.\/dist\/web/);
    assert.doesNotMatch(runtime, /node_modules|COPY test|COPY \.env|npm ci/, 'no build leftovers or dev dependencies at runtime');
  });

  it('never puts credentials in the image or its build context', async () => {
    const dockerfile = await read('Dockerfile');
    assert.doesNotMatch(dockerfile, /(ARG|ENV)[^\n]*(TOKEN|API_KEY|SECRET|PASSWORD)/i);
    const ignored = (await read('.dockerignore')).split('\n').map((line) => line.trim());
    for (const entry of ['.env', '.env.*', 'data', 'node_modules', 'dist', '.git', '.npmrc']) assert.ok(ignored.includes(entry), entry);
    const settings = (await read('compose.yaml')).split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(settings, /GITHUB_TOKEN|DEVIN_API_KEY/, 'credentials come only from .env at run time');
  });

  it('the container listener is allowed only inside the container; the host listener stays loopback', () => {
    assert.equal(loadSettings({ HOST: '0.0.0.0', BUG_SMASHER_CONTAINER: 'true' }).server.host, '0.0.0.0');
    assert.throws(() => loadSettings({ HOST: '0.0.0.0' }), /HOST must be a loopback address/);
    assert.throws(() => loadSettings({ HOST: '192.168.1.5', BUG_SMASHER_CONTAINER: 'true' }), /HOST must be a loopback address/);
  });
});

describe('verify-check', () => {
  it('proves a fixture fix with the real verifier, starting sandboxes on workspaces under the absolute VERIFY_WORK_DIR', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'bug-smasher-verify-check-'));
    try {
      const runtime = new LocalRuntime();
      const result = await verifyCheck({ runtime, image: 'node:22.18.0-bookworm-slim', workDir, timeoutSeconds: 60, checkCommand: CHECK_COMMAND });
      assert.equal(result.outcome.status, 'completed');
      assert.equal(result.outcome.status === 'completed' ? result.outcome.attempt.result : null, 'pass');
      assert.ok(runtime.starts.length >= 2);
      for (const spec of runtime.starts) {
        assert.ok(spec.workspace.startsWith(`${workDir}/`), 'the daemon is given host paths under VERIFY_WORK_DIR');
        assert.ok(spec.results.startsWith(`${workDir}/`));
        assert.equal(spec.image, 'node:22.18.0-bookworm-slim');
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  const image = process.env.VERIFY_DOCKER_IMAGE;
  it('runs in real sibling Docker containers when VERIFY_DOCKER_IMAGE is set', { skip: image === undefined ? 'set VERIFY_DOCKER_IMAGE (e.g. node:22.18.0-bookworm-slim) to run' : false }, async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'bug-smasher-verify-check-docker-'));
    try {
      const result = await verifyCheck({ runtime: new DockerRuntime(), image: image as string, workDir, timeoutSeconds: 300 });
      assert.equal(result.outcome.status === 'completed' ? result.outcome.attempt.result : result.outcome.reason, 'pass');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
