import type { AddressInfo } from 'node:net';
import { liveSettingsProblems, loadSettings, SettingsError, type Settings } from '../config/settings.ts';
import { DevinClient } from '../devin/client.ts';
import { DevinSetupClient } from '../devin/setup.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { PLAYBOOK_ROUTES, syncedPlaybookIds, type PlaybookIds } from '../orchestrator/playbooks.ts';
import { Prompts } from '../orchestrator/prompts.ts';
import { BugStore } from '../store/bug-store.ts';
import { GitHubTracker } from '../tracker/github.ts';
import { Dashboard } from '../dashboard/dashboard.ts';
import { verifierFromSettings, verifierSettingsProblems } from '../verify/verifier.ts';
import { createApp } from './app.ts';

let settings: Settings;
try {
  settings = loadSettings();
} catch (error) {
  if (error instanceof SettingsError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const { host, port, staticDir } = settings.server;

const dashboard = new Dashboard({ settings });
const server = createApp({ staticDir, dashboard });

server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`Bug Smasher scaffold listening on http://${displayHost}:${address.port}`);
});

async function startOrchestrator(settings: Settings): Promise<Orchestrator | null> {
  const problems = liveSettingsProblems(settings);
  if (problems.length > 0) {
    const message = `Workflow polling is off until live settings are complete: ${problems.join('; ')}`;
    console.log(message);
    dashboard.disconnect(message);
    return null;
  }
  const repo = settings.github.repo as NonNullable<Settings['github']['repo']>;
  const verifierProblems = verifierSettingsProblems(settings);
  if (verifierProblems.length > 0) {
    console.log(`Independent verification is unavailable until settings are complete: ${verifierProblems.join('; ')}`);
  }
  const verifier = verifierProblems.length === 0 ? verifierFromSettings(settings) : null;
  const store = await BugStore.open();
  const tracker = new GitHubTracker({ repo, token: settings.github.token as string });
  const devin = DevinClient.fromSettings(settings);
  const prompts = await Prompts.load();
  const playbookIds = await routePlaybookIds(settings, `${repo.owner}/${repo.name}`, prompts);
  const orchestrator: Orchestrator = new Orchestrator({
    store,
    tracker,
    devin,
    settings,
    prompts,
    playbookIds,
    ...(verifier === null ? {} : { verifier, reproducer: verifier }),
    requireLiveResults: true,
    trace: (event) => {
      if (event.type === 'cycle-finished') void dashboard.refresh();
      if (event.type === 'error' || event.type === 'effect-failed' || event.type === 'refused') {
        console.error(`[workflow] ${event.type} ${event.key ?? ''} ${JSON.stringify(event.detail)}`);
      }
    },
  });
  dashboard.connect({ store, tracker, devin, lastCycleAt: () => orchestrator.lastCycleAt });
  orchestrator.start();
  console.log(`Workflow polling ${repo.owner}/${repo.name} every ${settings.pollSeconds} s`);
  return orchestrator;
}

/** Synced route Playbooks to attach by id; on a lookup failure every route falls back to its inlined text. */
async function routePlaybookIds(settings: Settings, target: string, prompts: Prompts): Promise<PlaybookIds> {
  let ids: PlaybookIds = {};
  try {
    const setup = new DevinSetupClient({ apiKey: settings.devin.apiKey as string, orgId: settings.devin.orgId as string });
    ids = syncedPlaybookIds(await setup.listPlaybooks(), target, prompts);
  } catch (error) {
    console.error(`Devin Playbooks could not be listed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inlined = PLAYBOOK_ROUTES.filter((route) => ids[route] === undefined);
  if (inlined.length > 0) console.log(`Playbooks not synced (run npm run setup); inlining the procedure for: ${inlined.join(', ')}`);
  return ids;
}

const orchestrator = startOrchestrator(settings).catch((error: unknown) => {
  const message = `Workflow polling failed to start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(message);
  dashboard.disconnect(message);
  return null;
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down`);
  void orchestrator
    .then((running) => running?.stop())
    .finally(() => server.close(() => process.exit(0)));
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
