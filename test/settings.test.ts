import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertLiveSettings,
  effectiveSettings,
  liveSettingsProblems,
  loadSettings,
  SettingsError,
} from '../src/config/settings.ts';

const TOKEN = 'ghp_SECRETtoken1234567890';
const API_KEY = 'apk_SECRETkey0987654321';

const LIVE = {
  GITHUB_REPO: 'acme/widgets',
  GITHUB_TOKEN: TOKEN,
  DEVIN_API_KEY: API_KEY,
  DEVIN_ORG_ID: 'org-123',
  CHECK_COMMAND: 'npm test -- {files}',
};

function settingsError(env: Record<string, string>): SettingsError {
  try {
    loadSettings(env);
  } catch (error) {
    assert.ok(error instanceof SettingsError);
    return error;
  }
  assert.fail('expected loadSettings to throw');
}

describe('settings', () => {
  it('loads documented defaults with no environment and no credentials', () => {
    const settings = loadSettings({});
    assert.deepEqual(settings.labels, {
      triage: 'needs-triage',
      fix: 'bug-smasher',
      engineer: 'needs-engineer',
      feature: 'devin-builds-feature',
    });
    assert.equal(settings.decision, 'person');
    assert.equal(settings.merge, 'person');
    assert.equal(settings.mergeMaxLines, 200);
    assert.equal(settings.devin.maxActiveSessions, 3);
    assert.equal(settings.devin.maxAcuPerSession, 5);
    assert.equal(settings.maxFixRetries, 1);
    assert.equal(settings.devin.review, true);
    assert.equal(settings.pollSeconds, 60);
    assert.equal(settings.server.host, '127.0.0.1');
    assert.equal(settings.server.port, 8080);
    assert.equal(settings.github.token, null);
    assert.deepEqual(settings.cost, { acuPriceUsd: null, spendUsd: null, spendReadAt: null, budgetUsd: null });
  });

  it('parses valid overrides, including PORT=0 for ephemeral ports', () => {
    const settings = loadSettings({
      ...LIVE,
      PORT: '0',
      DECISION: 'rule',
      MERGE: 'AUTO',
      DEVIN_REVIEW: 'false',
      MAX_FIX_RETRIES: '0',
      DEVIN_ACU_PRICE_USD: '2.25',
      DEVIN_SPEND_USD: '0',
      DEVIN_SPEND_READ_AT: '2026-09-01T10:00:00Z',
      BASELINE_FILTER: 'unit',
    });
    assert.equal(settings.server.port, 0);
    assert.equal(settings.decision, 'rule');
    assert.equal(settings.merge, 'auto');
    assert.equal(settings.devin.review, false);
    assert.equal(settings.maxFixRetries, 0);
    assert.deepEqual(settings.github.repo, { owner: 'acme', name: 'widgets' });
    assert.deepEqual(settings.cost, {
      acuPriceUsd: 2.25,
      spendUsd: 0,
      spendReadAt: '2026-09-01T10:00:00.000Z',
      budgetUsd: null,
    });
    assert.equal(settings.baselineFilter, 'unit');
  });

  it('rejects invalid enum, boolean, numeric, repo and timestamp values instead of coercing them', () => {
    const error = settingsError({
      DECISION: 'robot',
      MERGE: 'yes',
      DEVIN_REVIEW: 'maybe',
      MERGE_MAX_LINES: '200 lines',
      MAX_ACTIVE_SESSIONS: '0',
      MAX_ACU_PER_SESSION: '2.5',
      MAX_FIX_RETRIES: '-1',
      POLL_SECONDS: '1e3',
      PORT: '70000',
      GITHUB_REPO: 'not a repo',
      DEVIN_BUDGET_USD: '-5',
      DEVIN_SPEND_READ_AT: 'yesterday',
    });
    const variables = error.problems.map((problem) => problem.split(' ')[0]);
    for (const name of [
      'DECISION',
      'MERGE',
      'DEVIN_REVIEW',
      'MERGE_MAX_LINES',
      'MAX_ACTIVE_SESSIONS',
      'MAX_ACU_PER_SESSION',
      'MAX_FIX_RETRIES',
      'POLL_SECONDS',
      'PORT',
      'GITHUB_REPO',
      'DEVIN_BUDGET_USD',
      'DEVIN_SPEND_READ_AT',
    ]) {
      assert.ok(variables.includes(name), `${name} should be reported: ${error.message}`);
    }
  });

  it('requires configured workflow labels to be distinct, ignoring case', () => {
    const error = settingsError({ FIX_LABEL: 'Needs-Triage' });
    assert.match(error.message, /FIX_LABEL must differ from TRIAGE_LABEL/);
    assert.doesNotThrow(() => loadSettings({ FIX_LABEL: 'repair-me' }));
  });

  it('does not require credentials outside live mode, and reports each missing live setting', () => {
    const settings = loadSettings({});
    const problems = liveSettingsProblems(settings);
    for (const name of ['GITHUB_REPO', 'GITHUB_TOKEN', 'DEVIN_API_KEY', 'DEVIN_ORG_ID', 'CHECK_COMMAND']) {
      assert.ok(problems.some((problem) => problem.startsWith(name)), `${name} missing from ${problems.join('; ')}`);
    }
    assert.throws(() => assertLiveSettings(settings), SettingsError);
    assert.doesNotThrow(() => assertLiveSettings(loadSettings(LIVE)));
  });

  it('requires CHECK_COMMAND to contain {files} in live mode', () => {
    const problems = liveSettingsProblems(loadSettings({ ...LIVE, CHECK_COMMAND: 'npm test' }));
    assert.deepEqual(problems, ['CHECK_COMMAND must contain {files}']);
  });

  it('never exposes tokens or keys in effective settings or errors', () => {
    const settings = loadSettings(LIVE);
    const projected = JSON.stringify(effectiveSettings(settings));
    assert.ok(!projected.includes(TOKEN));
    assert.ok(!projected.includes(API_KEY));
    assert.equal(effectiveSettings(settings).github.tokenConfigured, true);
    assert.equal(effectiveSettings(settings).devin.apiKeyConfigured, true);
    assert.equal(effectiveSettings(loadSettings({})).github.tokenConfigured, false);

    const error = settingsError({ ...LIVE, DECISION: 'nope', GITHUB_REPO: 'bad' });
    assert.ok(!error.message.includes(TOKEN) && !error.message.includes(API_KEY));
    const liveError = (() => {
      try {
        assertLiveSettings(loadSettings({ GITHUB_TOKEN: TOKEN, DEVIN_API_KEY: API_KEY }));
      } catch (caught) {
        return caught as Error;
      }
      assert.fail('expected live validation to fail');
    })();
    assert.ok(!liveError.message.includes(TOKEN) && !liveError.message.includes(API_KEY));
  });

  it('keeps unknown cost and usage as unknown, not zero', () => {
    const cost = effectiveSettings(loadSettings({})).cost;
    assert.equal(cost.acuPriceUsd, null);
    assert.equal(cost.spendUsd, null);
    assert.equal(cost.budgetUsd, null);
  });
});
