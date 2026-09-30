// Captures a run's results from a running Bug Smasher and renders its page.
//   npm run results -- results/<run>.run.json      -> results/<run>.json and results/<run>.html
//
// The run file (written by hand) has two parts:
//   inputs  repo, upstream, baseCommit, store (default data/bugs.json), usage (optional), comparison figures
//   page    every word on the page, as templates with {figure} placeholders (see results/superset-run.run.json)
// Figures come from the service's store and its own metrics (GET /api/overview, GET /api/metrics); the service
// is read at BUG_SMASHER_URL, or http://127.0.0.1:$PORT (default 8080). Per-bug cost needs a usage file: Devin's
// API reports no ACUs on this plan, so session costs are copied from Devin's usage history
// ({ "readAt": ..., "sessions": [{ "title": ..., "cost": ... }] }). This script writes no prose.
import fs from 'node:fs';
import path from 'node:path';
import { renderRun } from './render.mjs';

const mins = (a, b) => Math.round((new Date(b) - new Date(a)) / 6e4);
const median = xs => { const s = xs.filter(v => v != null).sort((a, b) => a - b); if (!s.length) return null; return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2); };
const usd = n => (n == null ? null : '$' + n.toFixed(2));
const dur = m => (m == null || !Number.isFinite(m) ? null : m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
const counts = reason => { const m = /fail on base \w+ \((\d+) of (\d+) test/.exec(reason || ''); return m ? { failed: +m[1], total: +m[2] } : null; };
const day = t => (t ? new Date(t).toLocaleDateString('en-GB', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', year: 'numeric' }).replace('Sept', 'Sep') : null);
const fetchJson = async url => { try { return await (await fetch(url, { signal: AbortSignal.timeout(120000) })).json(); } catch { return null; } };

export async function freeze(runFile) {
  const { inputs: inp, page } = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const base = (inp.service || process.env.BUG_SMASHER_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/$/, '');
  const GH = `https://github.com/${inp.repo}`;
  const overview = (await fetchJson(`${base}/api/overview`))?.overview?.issues ?? [];
  const M = (await fetchJson(`${base}/api/metrics`))?.metrics ?? null;
  if (!M) console.error(`warning: no metrics from ${base}/api/metrics; cost and pass-rate figures fall back to the store`);
  const usage = inp.usage && fs.existsSync(inp.usage) ? JSON.parse(fs.readFileSync(inp.usage, 'utf8')) : { sessions: [] };
  const store = Object.values(JSON.parse(fs.readFileSync(inp.store || 'data/bugs.json', 'utf8')).bugs)
    .filter(r => r.key.startsWith(`${inp.repo}#`));

  const rows = store.map(r => {
    const n = Number(r.key.split('#')[1]);
    const prs = [...(r.priorFixes || []), ...(r.fix ? [r.fix] : [])];
    const pass = r.verifications.filter(v => v.phase === 'pre-merge' && v.result === 'pass').at(-1);
    const first = r.verifications.find(v => v.phase === 'pre-merge');
    const at = s => r.stageHistory.find(h => h.stage === s)?.at;
    const q = at('queued'), proven = at('ready-to-merge'), handed = at('with-engineer');
    // Usage rows are newest first: a bug's newest "Investigate" session is this run, older ones earlier attempts.
    const mine = usage.sessions.filter(s => s.title.includes(`${inp.repo}#${n}:`));
    const inv = mine.filter(s => s.title.startsWith('Investigate'));
    const used = [...mine.filter(s => !s.title.startsWith('Investigate')), ...inv.slice(0, 1)];
    const c = counts(pass?.reason);
    const time = q && (proven || handed) ? mins(q, proven || handed) : null;
    return {
      label: `#${n}`, title: overview.find(i => i.number === n)?.title ?? r.triage?.title ?? r.key, url: `${GH}/issues/${n}`,
      second: r.triage?.recommendation ?? null, secondNote: r.triage?.confidence ?? null,
      outcome: { merged: 'merged', 'ready-to-merge': 'ready', 'with-engineer': 'engineer' }[r.stage] ?? r.stage,
      prNumber: prs.at(-1)?.prNumber ?? null, prUrl: prs.at(-1)?.prUrl ?? null,
      proofFailed: c?.failed ?? null, proofTotal: c?.total ?? null,
      tags: [...(r.verifications.some(v => v.evidence?.flags?.length) ? ['flagged'] : []), ...(prs.length > 1 ? ['retried'] : [])],
      time, timeText: dur(time),
      cost: used.length ? used.reduce((a, s) => a + s.cost, 0) : null,
      findingsMin: q && at('triaged') ? mins(q, at('triaged')) : null,
      provenMin: q && proven ? mins(q, proven) : null,
      prOpenMin: q && at('verifying') ? mins(q, at('verifying')) : null,
      prCount: prs.length,
      firstPass: first ? first.result === 'pass' : null,
      earlierCost: inv.slice(1).reduce((a, s) => a + s.cost, 0),
      at: q ?? null,
    };
  }).sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));

  const cmp = inp.comparison || {};
  const sent = rows.filter(r => r.prNumber);
  const proven = rows.filter(r => r.proofFailed != null).length;
  const spendTotal = M?.cost?.totalSpend?.value ?? (rows.some(r => r.cost != null) ? rows.reduce((a, r) => a + (r.cost || 0), 0) : null);
  const perSession = M?.cost?.costPerSession?.value ?? null;
  const provenTimes = rows.map(r => r.provenMin).filter(v => v != null);
  const figures = {
    name: inp.upstream ? inp.upstream.split('/')[1].replace(/^./, c => c.toUpperCase()) : inp.repo,
    repo: inp.repo, repoUrl: GH, upstream: inp.upstream, baseCommit: inp.baseCommit,
    since: day(rows.map(r => r.at).filter(Boolean).sort()[0]),
    bugs: rows.length,
    triaged: rows.filter(r => r.findingsMin != null).length,
    triageMedian: dur(median(rows.map(r => r.findingsMin))),
    recFix: rows.filter(r => r.second === 'devin_fix').length,
    recEngineer: rows.filter(r => r.second === 'needs_engineer').length,
    sentToFix: sent.length,
    prsOpened: rows.reduce((a, r) => a + r.prCount, 0),
    proven,
    firstTry: sent.filter(r => r.firstPass).length,
    handedOff: rows.filter(r => r.outcome === 'engineer').length,
    merged: rows.filter(r => r.outcome === 'merged').length,
    fixReadyMedian: dur(median(provenTimes)),
    fixReadyFastest: provenTimes.length ? dur(Math.min(...provenTimes)) : null,
    fixReadySlowest: provenTimes.length ? dur(Math.max(...provenTimes)) : null,
    prOpenMedian: dur(median(rows.map(r => r.prOpenMin))),
    totalSpend: usd(spendTotal),
    sessions: spendTotal != null && perSession ? Math.round(spendTotal / perSession) : null,
    perSession: usd(perSession),
    costPerFix: spendTotal != null && proven ? usd(spendTotal / proven) : null,
    earlierAttemptCost: usd(rows.reduce((a, r) => a + r.earlierCost, 0) || null),
    firstLabelHours: cmp.firstLabelHours != null ? `${cmp.firstLabelHours} h` : null,
    closeDays: cmp.medianDays != null ? `${cmp.medianDays} days` : null,
    comparisonMeasured: cmp.measured ?? null,
    spendReadAt: day(usage.readAt) ?? day(M?.cost?.totalSpend?.window?.end),
  };
  const dataFile = runFile.replace(/\.run\.json$/, '.json');
  fs.writeFileSync(dataFile, JSON.stringify({ frozenAt: new Date().toISOString(), figures, rows, page }, null, 2));
  return [dataFile, renderRun(dataFile)];
}

if (import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const runFile = process.argv[2];
  if (!runFile || !runFile.endsWith('.run.json')) { console.error('usage: npm run results -- results/<run>.run.json'); process.exit(2); }
  for (const f of await freeze(runFile)) console.log(f);
}
