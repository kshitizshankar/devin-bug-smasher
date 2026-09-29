import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startService } from './helpers/service.ts';

const TOKEN = 'ghp_SECRETtoken1234567890';

describe('service settings', () => {
  it('starts and serves health with no provider credentials in the environment', async () => {
    const service = await startService({ GITHUB_TOKEN: '', DEVIN_API_KEY: '', GITHUB_REPO: '', DEVIN_ORG_ID: '' });
    try {
      const response = await fetch(new URL('/api/health', service.baseUrl));
      assert.equal(response.status, 200);
    } finally {
      await service.stop();
    }
  });

  it('refuses to start on an invalid setting with a clear, secret-free error', async () => {
    await assert.rejects(startService({ MERGE: 'sometimes', GITHUB_TOKEN: TOKEN }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited before ready \(code=1/);
      assert.match(error.message, /MERGE "sometimes" is invalid: expected one of person, rule, auto/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });
});
