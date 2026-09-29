import { readFile } from 'node:fs/promises';
import type { Settings } from '../config/settings.ts';
import { Dashboard, type DashboardApi } from '../dashboard/dashboard.ts';
import type { MetricsResponse, OverviewResponse, SettingsResponse } from '../dashboard/types.ts';
import type { LoadedRecording } from './recording.ts';
import { openReplay, replayDashboard, type ReplayPaths } from './replay.ts';

const WATCH_MS = 1000;

/** A replay-mode dashboard with nothing to serve: every response is simulated and unavailable. */
export function unavailableReplayDashboard(settings: Settings, reason: string): Dashboard {
  const dashboard = new Dashboard({ settings, mode: 'replay', data: () => ({ mode: 'replay', simulated: true, replay: null }) });
  dashboard.disconnect(reason);
  return dashboard;
}

async function stateText(paths: ReplayPaths): Promise<string> {
  try {
    return await readFile(paths.state, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Replay mode of the service: serves the read-only dashboard over the replay store and follows the replay
 * position that `npm run replay` commands write. It never plays steps or writes anything itself; each time
 * the position changes it rebuilds the stand-in providers to that position and checks them against the store.
 */
export class ReplayService implements DashboardApi {
  readonly #paths: ReplayPaths;
  readonly #loaded: LoadedRecording;
  readonly #settings: Settings;
  #current: Dashboard;
  #seen: string | null = null;
  #loading: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(paths: ReplayPaths, loaded: LoadedRecording, settings: Settings) {
    this.#paths = paths;
    this.#loaded = loaded;
    this.#settings = settings;
    this.#current = this.#unavailable('The replay is loading');
  }

  #unavailable(reason: string): Dashboard {
    return unavailableReplayDashboard(this.#settings, reason);
  }

  /** Loads the current position now, then follows changes until `stop()`. */
  async start(): Promise<void> {
    await this.reload();
    this.#timer = setInterval(() => void this.reload(), WATCH_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Rebuilds when the replay position changed since the last load; concurrent calls share one load. */
  reload(): Promise<void> {
    this.#loading ??= this.#reload().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #reload(): Promise<void> {
    let text: string;
    try {
      text = await stateText(this.#paths);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (text === this.#seen) return;
    this.#seen = text;
    try {
      const replay = await openReplay(this.#paths, this.#loaded, this.#settings);
      try {
        this.#current = await replayDashboard(replay.world);
      } finally {
        await replay.close();
      }
      console.log(`Replay ${this.#loaded.recording.id}: serving step ${replay.world.played} of ${this.#loaded.recording.steps.length} (simulated data)`);
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    const reason = `Replay unavailable: ${error instanceof Error ? error.message : String(error)}`;
    console.error(reason);
    this.#current = this.#unavailable(reason);
  }

  overview(): OverviewResponse {
    return this.#current.overview();
  }

  metrics(): MetricsResponse {
    return this.#current.metrics();
  }

  settings(): SettingsResponse {
    return this.#current.settings();
  }
}
