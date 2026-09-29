import type { DevinSetupClient, SnapshotBuild } from '../devin/setup.ts';
import { failedSteps, parseBuildLog } from './build-log.ts';

export interface EnvStatus {
  build: SnapshotBuild;
  lines: string[];
  /** True only for a succeeded build whose log shows recognised steps and none failed. */
  healthy: boolean;
}

function time(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function latest(builds: readonly SnapshotBuild[]): SnapshotBuild | undefined {
  const moment = (build: SnapshotBuild): number => Math.max(time(build.created_at), time(build.started_at), time(build.completed_at));
  return [...builds].sort((a, b) => moment(b) - moment(a))[0];
}

/** Reads one build (the latest when `buildId` is null) and its log, step by step. Read-only. */
export async function envStatus(devin: DevinSetupClient, buildId: string | null): Promise<EnvStatus | null> {
  const build = buildId === null ? latest(await devin.listBuilds()) : await devin.getBuild(buildId);
  if (build === undefined) return null;
  const log = parseBuildLog(await devin.fetchDownload('get-build-logs', await devin.getBuildLogs(build.build_id)));
  const failed = failedSteps(log);
  const lines = [`Build ${build.build_id}: Devin reports ${build.status}`];
  if (!log.recognised) {
    lines.push('The build log shows no steps this command recognises, so step results are unknown.');
  } else {
    lines.push(`Steps: ${log.steps.length} recognised, ${failed.length} failed`);
    for (const step of log.steps) {
      const exit = step.exitCode === null ? '' : `, exit code ${step.exitCode}`;
      lines.push(`  ${step.outcome.padEnd(7)} ${step.path.join(' > ')} (log line ${step.line}${exit})`);
    }
  }
  if (build.status === 'succeeded' && failed.length > 0) {
    lines.push(
      `Build ${build.build_id} reports succeeded, but ${failed.length} nested step${failed.length === 1 ? '' : 's'} failed: ` +
        `${failed.map((step) => step.path.join(' > ')).join('; ')}. Sessions may start without what those steps set up.`,
    );
  } else if (build.status === 'pending' || build.status === 'running') {
    lines.push(`Build ${build.build_id} has not finished; run env-status again later.`);
  }
  const healthy = build.status === 'succeeded' && log.recognised && failed.length === 0;
  return { build, lines, healthy };
}
