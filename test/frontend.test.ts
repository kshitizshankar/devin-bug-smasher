import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { repoRoot, startService, type RunningService } from './helpers/service.ts';

const builtIndex = join(repoRoot, 'dist', 'web', 'index.html');

function rawGetStatus(baseUrl: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('built frontend assets', () => {
  let service: RunningService;

  before(async () => {
    assert.ok(existsSync(builtIndex), `Missing ${builtIndex}. Run \`npm run build\` before the smoke tests.`);
    service = await startService();
  });

  after(async () => {
    await service?.stop();
  });

  it('serves the built placeholder index.html at /', async () => {
    const response = await fetch(new URL('/', service.baseUrl));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(html, await readFile(builtIndex, 'utf8'));
    assert.match(html, /<title>Bug Smasher \(scaffold\)<\/title>/);
    assert.match(html, /<div id="root"><\/div>/);
  });

  it('serves every script and stylesheet referenced by the built index.html', async () => {
    const html = await readFile(builtIndex, 'utf8');
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1] ?? '');

    assert.ok(assetPaths.some((path) => path.endsWith('.js')), 'expected a built JavaScript bundle');
    assert.ok(assetPaths.some((path) => path.endsWith('.css')), 'expected a built stylesheet');

    for (const assetPath of assetPaths) {
      const response = await fetch(new URL(assetPath, service.baseUrl));
      const expected = await readFile(join(repoRoot, 'dist', 'web', assetPath));

      assert.equal(response.status, 200, `status for ${assetPath}`);
      const expectedType = assetPath.endsWith('.js') ? /^text\/javascript/ : /^text\/css/;
      assert.match(response.headers.get('content-type') ?? '', expectedType, `content type for ${assetPath}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `body for ${assetPath}`);
    }
  });

  it('falls back to index.html for client-side routes', async () => {
    const response = await fetch(new URL('/some/client/route', service.baseUrl));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(builtIndex, 'utf8'));
  });

  it('returns 404 for missing asset files', async () => {
    const response = await fetch(new URL('/assets/missing.js', service.baseUrl));

    assert.equal(response.status, 404);
  });

  it('does not serve files outside the static directory', async () => {
    assert.equal(await rawGetStatus(service.baseUrl, '/../package.json'), 404);
    assert.equal(await rawGetStatus(service.baseUrl, '/%2e%2e/package.json'), 404);
  });
});
