import { DevinClient, type DevinClientOptions } from '../../src/devin/client.ts';
import { OfflineDevin } from '../../src/devin/offline.ts';

export const API_KEY = 'cog_SECRETdevinKey1234567890';
export const ORG_ID = 'org-offline';
export const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const PR_URL = 'https://github.com/acme/widgets/pull/7';

/** Fails loudly if anything reaches the real network during Devin tests. */
export function forbidRealNetwork(): void {
  globalThis.fetch = () => {
    throw new Error('Devin tests must not contact the network');
  };
}

export function offlineClient(
  options: Partial<DevinClientOptions> = {},
  offlineOptions: { maxPageSize?: number } = {},
): { offline: OfflineDevin; client: DevinClient } {
  const offline = new OfflineDevin({ apiKey: API_KEY, orgId: ORG_ID, ...offlineOptions });
  let attempt = 0;
  const client = new DevinClient({
    apiKey: API_KEY,
    orgId: ORG_ID,
    maxAcuPerSession: 5,
    reviewEnabled: true,
    fetch: offline.fetch,
    newAttemptId: () => `attempt-${++attempt}`,
    ...options,
  });
  return { offline, client };
}

export const COMPLETE_TRIAGE = {
  phase: 'triage',
  status: 'triage_complete',
  title: 'Chart legend overlaps axis labels',
  summary: 'The legend is drawn over the x-axis labels when the chart is narrow.',
  steps_to_reproduce: ['Open a chart', 'Resize to 400px'],
  expected: 'Legend is placed below the axis',
  actual: 'Legend overlaps the axis labels',
  suspected_cause: 'Legend offset ignores axis height',
  affected_files: ['src/chart/legend.ts'],
  reproduced: true,
  reproduction_notes: 'Reproduced with the unit test below',
  proposed_check: { description: 'Legend offset accounts for axis', test_file: 'test/legend.test.ts', command: 'npm test -- test/legend.test.ts' },
  bucket: 'devin_fix',
  bucket_reason: 'Small, well-understood layout bug',
  confidence: 'high',
};
