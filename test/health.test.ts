import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startService, type RunningService } from './helpers/service.ts';

describe('service health', () => {
  let service: RunningService;

  before(async () => {
    service = await startService();
  });

  after(async () => {
    await service?.stop();
  });

  it('responds to GET /api/health with an ok status', async () => {
    const response = await fetch(new URL('/api/health', service.baseUrl));

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'bug-smasher' });
  });

  it('rejects non-GET requests to the health endpoint', async () => {
    const response = await fetch(new URL('/api/health', service.baseUrl), { method: 'POST' });

    assert.equal(response.status, 405);
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const response = await fetch(new URL('/api/does-not-exist', service.baseUrl));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});
