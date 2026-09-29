import type { AddressInfo } from 'node:net';
import { liveSettingsProblems, loadSettings, SettingsError, type Settings } from '../config/settings.ts';
import { DevinClient } from '../devin/client.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { Prompts } from '../orchestrator/prompts.ts';
import { BugStore } from '../store/bug-store.ts';
import { GitHubTracker } from '../tracker/github.ts';
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

const server = createApp({ staticDir });

server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`Bug Smasher scaffold listening on http://${displayHost}:${address.port}`);
});

async function startOrchestrator(settings: Settings): Promise<Orchestrator | null> {
  const problems = liveSettingsProblems(settings);
  if (problems.length > 0) {
    console.log(`Workflow polling is off until live settings are complete: ${problems.join('; ')}`);
    return null;
  }
  const repo = settings.github.repo as NonNullable<Settings['github']['repo']>;
  const verifierProblems = verifierSettingsProblems(settings);
  if (verifierProblems.length > 0) {
    console.log(`Independent verification is unavailable until settings are complete: ${verifierProblems.join('; ')}`);
  }
  const verifier = verifierProblems.length === 0 ? verifierFromSettings(settings) : null;
  const orchestrator = new Orchestrator({
    store: await BugStore.open(),
    tracker: new GitHubTracker({ repo, token: settings.github.token as string }),
    devin: DevinClient.fromSettings(settings),
    settings,
    prompts: await Prompts.load(),
    ...(verifier === null ? {} : { verifier, reproducer: verifier }),
    requireLiveResults: true,
    trace: (event) => {
      if (event.type === 'error' || event.type === 'effect-failed' || event.type === 'refused') {
        console.error(`[workflow] ${event.type} ${event.key ?? ''} ${JSON.stringify(event.detail)}`);
      }
    },
  });
  orchestrator.start();
  console.log(`Workflow polling ${repo.owner}/${repo.name} every ${settings.pollSeconds} s`);
  return orchestrator;
}

const orchestrator = startOrchestrator(settings).catch((error: unknown) => {
  console.error(`Workflow polling failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
