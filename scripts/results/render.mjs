// Renders a results page from its data file only.
//   node scripts/results/render.mjs results/<run>.json   -> results/<run>.html
// The data file holds figures and rows (written by freeze.mjs) and the page's words (copied from the run file).
// Words are templates: {name} is replaced by figures.name. No wording lives in this file.
import fs from 'node:fs';
import path from 'node:path';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = n => n == null ? '—' : '$' + n.toFixed(2);
const tz = 'Europe/Berlin';
const hm = t => new Date(t).toLocaleTimeString('sv-SE', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const dmhm = t => new Date(t).toLocaleString('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
// Shorten at a word boundary so labels never end mid-word.
const clip = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/[\s,;:.-]+\S*$/, '').replace(/[\s,;:.-]+$/, '') + '…';
const tip = (title, lines = []) => `data-tip="${esc([title, ...lines].join('\n'))}"`;

const STYLE = `:root{--page:#f5f7fa;--card:#fff;--ink:#0f1a2a;--ink2:#52637a;--muted:#8592a6;--grid:#e6ebf2;--line:#dfe5ee;--track:#e9eef5;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--good:#0b7a43;--chip:#eef2f8;--shadow:0 1px 2px #1321380a,0 8px 24px #13213808;color-scheme:light}
[data-theme=dark]{--page:#0e1521;--card:#151e2d;--ink:#eef2f8;--ink2:#b9c4d4;--muted:#8fa0b8;--grid:#243249;--line:#26344a;--track:#243249;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--good:#3fbf85;--chip:#1e2b40;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:28px 28px 40px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font-size:28px;letter-spacing:-.6px;margin:6px 0 4px}.sub{color:var(--ink2);font-size:14px}
.right{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 13px;font-size:12px;color:var(--ink2);box-shadow:var(--shadow)}.pill b{color:var(--ink)}
#theme-switch{display:flex;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:3px;font:600 12px Inter,system-ui,sans-serif}
#theme-switch button{border:0;background:none;padding:5px 11px;border-radius:6px;cursor:pointer;color:var(--ink2)}#theme-switch button[aria-pressed=true]{background:var(--s1);color:#fff}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--shadow)}
.tile .label{font-size:12px;color:var(--ink2)}.tile .value{font-size:30px;font-weight:700;letter-spacing:-1px;margin:4px 0 2px;font-variant-numeric:tabular-nums}.tile .value small{font-size:16px;color:var(--muted);font-weight:600;letter-spacing:0}
.tile .note{font-size:12px;color:var(--muted)}.good{color:var(--good)!important;font-weight:600}
.segs{display:flex;gap:2px;margin:10px 0 4px}.seg{flex:1;height:8px;border-radius:2px;background:var(--track)}.seg.done{background:var(--s1)}.seg.live{background:var(--s1);opacity:.4}
h2{font-size:15px;margin:0 0 2px;letter-spacing:-.2px}.cap{font-size:12px;color:var(--muted);margin-bottom:10px}
.legend{display:flex;gap:18px;font-size:12px;color:var(--ink2);margin:8px 0 2px;flex-wrap:wrap}.legend i{display:inline-block;width:14px;height:8px;border-radius:2px;margin-right:6px;vertical-align:middle}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.stack{display:flex;flex-direction:column;gap:14px}
svg{width:100%;height:auto;display:block;overflow:visible}
svg .grid{stroke:var(--grid);stroke-width:1}svg .axis{fill:var(--muted);font-size:11px}svg .rowlabel{fill:var(--ink2);font-size:12px}svg .val{fill:var(--ink);font-size:12px;font-weight:600;paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}
svg .buffer{fill:var(--s2);opacity:.07}svg .bufferlabel{fill:var(--ink2);font-size:12px;font-weight:600}
svg .bar{transition:opacity .12s}svg .bar.s1{fill:var(--s1)}svg .bar.s2{fill:var(--s2)}svg .bar.s3{fill:var(--s3)}svg .bar.soft{opacity:.45}
svg .bar.proj{fill:none;stroke:var(--muted);stroke-width:1.5;opacity:.7}svg .dot.s1{fill:var(--s1);stroke:var(--card);stroke-width:2}
svg .track{fill:var(--track)}svg .mark{stroke-width:2}svg .mark.now{stroke:var(--ink2)}svg .mark.dl{stroke:var(--s2)}
svg .marklabel{fill:var(--ink2);font-size:11px;font-weight:600}svg [data-tip]:hover{opacity:.8}
.legend .p{background:none;border:1.5px solid var(--muted);height:8px;width:14px}
.spendrow{display:flex;gap:22px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin-top:2px}.spendrow i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}.spendrow b{color:var(--ink)}
.qrow{display:grid;grid-template-columns:44px 1fr auto 56px;gap:10px;align-items:center;padding:6px 4px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px}.qrow:first-child{border-top:0}.qrow:hover{background:var(--chip);border-radius:6px}
.qid{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.qt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qc{text-align:right;color:var(--ink2);font-variant-numeric:tabular-nums;font-size:12px}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--ink2)}.chip.ok{color:var(--good)}.chip.live{background:var(--s1);color:#fff}
.act{display:grid;grid-template-columns:44px 1fr;gap:10px;font-size:12.5px;padding:5px 0;border-top:1px solid var(--line);color:var(--ink2)}.act:first-child{border-top:0}.act time{color:var(--muted);font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.small{font-size:12px}footer{margin-top:18px;color:var(--muted);font-size:12px}
#tip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:var(--card);border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.45;white-space:pre;opacity:0;transition:opacity .08s}
@media(max-width:1000px){.tiles{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}}
/* Skin: Stripe-inspired (deep navy ink, purple accent, light-weight tabular numerals, blue-tinted shadows, tight radii).
   Series colours are the validated dataviz set (purple, orange, aqua) and pass the colour-blind checks in both themes. */
:root{--page:#f6f9fc;--card:#fff;--ink:#061b31;--ink2:#273951;--muted:#8898aa;--grid:#eef2f7;--line:#e5edf5;--track:#edf1f7;--s1:#533afd;--s2:#eb6834;--s3:#1baf7a;--good:#108c3d;--chip:#f6f9fc;--hero:#1c1e54;--shadow:0 15px 35px rgba(50,50,93,.10),0 3px 6px rgba(0,0,0,.05)}
[data-theme=dark]{--page:#061729;--card:#0d2238;--ink:#f0f5fb;--ink2:#c5d1e0;--muted:#7f95b2;--grid:#17304a;--line:#1d3a58;--track:#17304a;--s1:#8b80ff;--s2:#d95926;--s3:#199e70;--good:#3fbf85;--chip:#12304d;--hero:#1c1e54;--shadow:none}
body{font-family:"sohne-var","SF Pro Display",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-feature-settings:"ss01";-webkit-font-smoothing:antialiased}
body::before{content:"";display:block;height:3px;background:linear-gradient(90deg,#533afd,#f96bee 55%,#ea2261)}
.wrap{padding-top:34px}
.eyebrow{color:var(--s1);letter-spacing:.16em}
h1{font-weight:300;font-size:36px;letter-spacing:-1px}.sub{color:#64748d}[data-theme=dark] .sub{color:#8ea3bd}
h2{font-weight:500;font-size:15px;color:var(--ink)}.cap{color:#64748d;font-size:12.5px}[data-theme=dark] .cap,[data-theme=dark] .tile .label,[data-theme=dark] .tile .note{color:#8ea3bd}
.card{border-radius:8px;padding:22px 24px}
.pill{border-radius:6px;box-shadow:none;color:#64748d}#theme-switch{border-radius:6px}#theme-switch button{border-radius:4px}
.tile .label{color:#64748d;font-size:12.5px}.tile .note{color:#64748d}
.tile .value{font-weight:300;font-size:40px;letter-spacing:-1.4px;font-feature-settings:"tnum";margin:8px 0 4px}.tile .value small{font-weight:300;font-size:18px;letter-spacing:0}
.tile.hero{background:var(--hero);border-color:transparent;box-shadow:0 15px 35px rgba(28,30,84,.28)}
.tile.hero .label,.tile.hero .note,.tile.hero .value small{color:#b9b9f9}.tile.hero .value{color:#fff}
.tile.hero .seg{background:rgba(255,255,255,.16)}.tile.hero .seg.done{background:#b9b9f9}.tile.hero .seg.live{background:#b9b9f9;opacity:.5}
.chip{border-radius:4px;font-weight:500}.chip.ok{background:rgba(21,190,83,.14);color:var(--good)}.chip.live{background:var(--s1);color:#fff}
.qrow:hover{border-radius:4px}
svg .bar.proj{stroke:var(--s1);opacity:.55}svg .mark.now{stroke:var(--s1)}svg .marklabel{fill:var(--s1)}
svg .val{font-feature-settings:"tnum";font-weight:500}
`;
const SCRIPT = `<script>(function(){var K='bug-smasher-theme',d=document.documentElement,mq=matchMedia('(prefers-color-scheme: dark)'),s=document.getElementById('theme-switch');
function apply(c){d.setAttribute('data-theme',c==='auto'?(mq.matches?'dark':'light'):c);[].forEach.call(s.children,function(b){b.setAttribute('aria-pressed',b.dataset.c===c)})}
['auto','light','dark'].forEach(function(v){var b=document.createElement('button');b.type='button';b.dataset.c=v;b.textContent=v[0].toUpperCase()+v.slice(1);b.onclick=function(){localStorage.setItem(K,v);apply(v)};s.appendChild(b)});
apply(localStorage.getItem(K)||'auto');mq.addEventListener('change',function(){if((localStorage.getItem(K)||'auto')==='auto')apply('auto')});
var t=document.getElementById('tip');document.addEventListener('mousemove',function(e){var el=e.target.closest&&e.target.closest('[data-tip]');if(!el){t.style.opacity=0;return}t.textContent=el.getAttribute('data-tip');t.style.opacity=1;t.style.left=Math.min(e.clientX+14,innerWidth-t.offsetWidth-8)+'px';t.style.top=(e.clientY+16)+'px'});})();</script>`;

function bars(items, { unit = '', fmt = v => v.toFixed(2), refLine = null, refLabel = '' } = {}) {
  const W = 560, left = 250, right = 84, rowH = 30, barH = 10, top = refLine != null ? 28 : 8;
  const max = Math.max(...items.map(i => i.v), refLine || 0) * 1.05 || 1;
  const H = top + items.length * rowH + 8;
  const x = v => left + v / max * (W - left - right);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  svg += `<line class="grid" x1="${left}" x2="${left}" y1="${top - 4}" y2="${H - 6}"/>`;
  // Reference line first, so bars and value labels sit on top of it instead of being crossed by it.
  if (refLine != null) {
    svg += `<line class="mark now" x1="${x(refLine)}" x2="${x(refLine)}" y1="${top - 6}" y2="${H - 6}"/><text class="marklabel" x="${x(refLine)}" y="${top - 12}" text-anchor="middle">${esc(refLabel)}</text>`;
  }
  items.forEach((it, i) => {
    const cy = top + i * rowH + rowH / 2, w = Math.max(3, x(it.v) - left);
    svg += `<text class="rowlabel" x="${left - 12}" y="${cy + 4}" text-anchor="end">${esc(clip(it.label, 38))}</text>`;
    // rounded data-end, square at the baseline
    const r = Math.min(4, w / 2);
    svg += `<path class="bar s1 ${it.soft ? 'soft' : ''}" ${tip(it.label, it.tip || [])} d="M${left},${cy - barH / 2} H${left + w - r} a${r},${r} 0 0 1 ${r},${r} V${cy + barH / 2 - r} a${r},${r} 0 0 1 -${r},${r} H${left} Z"/>`;
    const valText = `${fmt(it.v)}${unit}${it.soft ? ' so far' : ''}`;
    let lx = left + w + 8;
    // If the reference line would cross the label, move the label to the far side of the line.
    if (refLine != null && x(refLine) > lx - 4 && x(refLine) < lx + valText.length * 7 + 4) lx = x(refLine) + 8;
    svg += `<text class="val" x="${lx}" y="${cy + 4}">${valText}</text>`;
  });
  return svg + '</svg>';
}

// The workflow diagram (docs/architecture drawing 3, same layout and look) with live numbers: each stage shows how
// many items are in it and which ones; each path shows how many took it. Words come from the run file's `workflow`
// block; a stage's `value` overrides the count of rows whose `node` is that stage (for pages whose rows are not the
// items), and its `foot` shows when no item is there.
function workflowSvg(W, rows, fill) {
  const N = W.nodes, E = W.edges || {};
  const here = k => rows.filter(r => r.node === k);
  const count = k => (N[k]?.value != null ? Number(fill(N[k].value)) || 0 : here(k).length);
  const chipW = r => 12 + r.label.length * 7;
  const chipRow = (items, x, y, maxW, align = 'start') => {
    const shown = [];
    let used = 0;
    for (const r of items) { if (used + chipW(r) > maxW - 34) break; shown.push(r); used += chipW(r) + 5; }
    const more = items.length - shown.length;
    let cx = align === 'end' ? x - used - (more ? 30 : 0) : x;
    let out = '';
    for (const r of shown) {
      out += `<a href="${esc(r.url)}"><g class="wf-chip" ${tip(`${r.label} ${r.title}`)}><rect x="${cx}" y="${y}" width="${chipW(r)}" height="18" rx="4"/><text x="${cx + 6}" y="${y + 13}">${esc(r.label)}</text></g></a>`;
      cx += chipW(r) + 5;
    }
    if (more) out += `<text class="wf-s" x="${cx + 2}" y="${y + 13}">${esc(fill(W.more ?? '+{n}').replace('{n}', more))}</text>`;
    return out;
  };
  const pill = (n, x, y) => {
    const w = 16 + String(n).length * 8;
    return `<rect class="wf-pill${n ? ' on' : ''}" x="${x - w}" y="${y}" width="${w}" height="22" rx="11"/><text class="wf-pilltext${n ? ' on' : ''}" x="${x - w / 2}" y="${y + 15}" text-anchor="middle">${n}</text>`;
  };
  const GLYPH = {
    backlog: (x, y) => `<rect class="wf-glyph" x="${x + 9}" y="${y + 11}" width="18" height="14" rx="2"/><path class="wf-glyph" d="M${x + 9} ${y + 19} H${x + 14} L${x + 16} ${y + 22} H${x + 20} L${x + 22} ${y + 19} H${x + 27}"/>`,
    triage: (x, y) => `<circle class="wf-glyph" cx="${x + 16}" cy="${y + 16}" r="6"/><path class="wf-glyph" d="M${x + 20.5} ${y + 20.5} L${x + 26} ${y + 26}"/>`,
    fix: (x, y) => `<path class="wf-glyph" d="M${x + 14} ${y + 12} L${x + 9} ${y + 18} L${x + 14} ${y + 24} M${x + 22} ${y + 12} L${x + 27} ${y + 18} L${x + 22} ${y + 24} M${x + 20} ${y + 10} L${x + 16} ${y + 26}"/>`,
    merged: (x, y) => `<rect class="wf-glyph" x="${x + 10}" y="${y + 10}" width="16" height="16" rx="3"/><path class="wf-glyph" d="M${x + 14} ${y + 18} L${x + 17} ${y + 21} L${x + 22} ${y + 15}"/>`,
  };
  const card = (k, x, y, tone) => {
    const items = here(k), n = count(k);
    const foot = items.length ? chipRow(items, x + 14, y + 73, 212)
      : `<circle class="wf-dot ${tone}" cx="${x + 18}" cy="${y + 82}" r="3.5"/><text class="wf-m" x="${x + 28}" y="${y + 86}">${esc(fill(N[k].foot ?? ''))}</text>`;
    return `<g class="wf-card"><rect class="wf-cardbg" x="${x}" y="${y}" width="240" height="96" rx="12"/>`
      + `<path class="wf-foot" d="M${x} ${y + 68} H${x + 240} V${y + 84} Q${x + 240} ${y + 96} ${x + 228} ${y + 96} H${x + 12} Q${x} ${y + 96} ${x} ${y + 84} Z"/><line class="wf-tick" x1="${x}" y1="${y + 68}" x2="${x + 240}" y2="${y + 68}"/>`
      + `<rect class="wf-tile ${tone}" x="${x + 14}" y="${y + 14}" width="36" height="36" rx="9"/><g class="wf-g ${tone}">${GLYPH[k](x + 14, y + 14)}</g>`
      + `<text class="wf-h" x="${x + 62}" y="${y + 30}">${esc(fill(N[k].title))}</text><text class="wf-s" x="${x + 62}" y="${y + 48}">${esc(fill(N[k].sub))}</text>`
      + pill(n, x + 226, y + 16) + foot + '</g>';
  };
  const gate = (k, cx, cy, side) => {
    const tx = side === 'left' ? cx - 36 : cx + 36, anchor = side === 'left' ? 'end' : 'start';
    return `<polygon class="wf-gate" points="${cx},${cy - 24} ${cx + 24},${cy} ${cx},${cy + 24} ${cx - 24},${cy}"/>`
      + `<text class="wf-h" x="${tx}" y="${cy - 4}" text-anchor="${anchor}">${esc(fill(N[k].title))}</text>`
      + `<text class="wf-s" x="${tx}" y="${cy + 14}" text-anchor="${anchor}">${esc(fill(N[k].sub))}</text>`
      + chipRow(here(k), tx, cy + 24, 190, side === 'left' ? 'end' : 'start');
  };
  // A path label reads "4 to fix" when items took it, and just "to fix" when none did.
  const lab = (k, x, y, anchor = 'start') => {
    const e = E[k]; if (!e) return '';
    const n = e.value != null ? Number(fill(e.value)) || 0 : 0;
    return `<text class="wf-s wf-halo" x="${x}" y="${y}" text-anchor="${anchor}">${n ? `<tspan class="wf-c">${n}</tspan> ` : ''}${esc(fill(e.label))}</text>`;
  };
  return `<svg viewBox="0 0 1040 640" role="img" class="wf-svg"><defs>`
    + `<marker id="wf-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="wf-ah" d="M0,0 L10,5 L0,10 z"/></marker>`
    + `<marker id="wf-ah-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="wf-ah warn" d="M0,0 L10,5 L0,10 z"/></marker>`
    + `<pattern id="wf-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle class="wf-dotgrid" cx="2" cy="2" r="1"/></pattern></defs>`
    + `<rect class="wf-canvas" x="0" y="0" width="1040" height="640" rx="14"/><rect x="0" y="0" width="1040" height="640" rx="14" fill="url(#wf-dots)"/>`
    + `<path class="wf-edge" d="M640 88 H800 Q820 88 820 108 V250" marker-end="url(#wf-ah)"/>${lab('labelled', 830, 170)}`
    + `<path class="wf-edge" d="M820 354 V396" marker-end="url(#wf-ah)"/>`
    + `<path class="wf-edge" d="M820 444 V528 Q820 548 800 548 H642" marker-end="url(#wf-ah)"/>${lab('toFix', 830, 500)}`
    + `<path class="wf-edge" d="M400 548 H240 Q220 548 220 528 V446" marker-end="url(#wf-ah)"/>${lab('proven', 310, 540, 'middle')}`
    + `<path class="wf-edge" d="M220 396 V356" marker-end="url(#wf-ah)"/>${lab('merged', 210, 380, 'end')}`
    + `<path class="wf-edge warn" d="M700 282 C640 282 600 230 600 146" marker-end="url(#wf-ah-warn)"/>${lab('engineer', 592, 214, 'end')}`
    + `<path class="wf-edge dashed" d="M450 146 V492" marker-end="url(#wf-ah)"/>${lab('straight', 440, 214, 'end')}`
    + `<path class="wf-edge" d="M844 420 H1000" marker-end="url(#wf-ah)"/>${lab('close', 922, 411, 'middle')}`
    + `<path class="wf-edge dotted" d="M566 302 H698"/><path class="wf-edge dotted" d="M520 404 V492"/>`
    + `<circle class="wf-cardbg" cx="520" cy="302" r="46"/><rect class="wf-tile accent" x="498" y="280" width="44" height="44" rx="11"/>`
    + `<g class="wf-g accent"><polygon class="wf-glyph" points="520,293 528,297.5 528,306.5 520,311 512,306.5 512,297.5"/></g><circle class="wf-glyphfill" cx="520" cy="302" r="2.5"/>`
    + `<text class="wf-h" x="520" y="370" text-anchor="middle">${esc(fill(W.devin ?? 'Devin'))}</text><text class="wf-s" x="520" y="389" text-anchor="middle">${esc(fill(W.devinSub ?? ''))}</text>`
    + gate('decision', 820, 420, 'left') + gate('merge', 220, 420, 'right')
    + card('backlog', 400, 40, 'muted') + card('triage', 700, 252, 'accent') + card('fix', 400, 494, 'accent') + card('merged', 100, 254, 'ok')
    + '</svg>';
}

export function renderRun(dataFile) {
  const { frozenAt, figures: F, rows, page: P } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const fill = t => String(t ?? '').replace(/\{(\w+)\}/g, (_, k) => (F[k] ?? '—'));
  const md = t => esc(fill(t)).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const word = (group, key) => P.words?.[group]?.[key] ?? key ?? '—';

  const sec = k => P.sections?.[k] ? `<div class="sechead"><h3>${md(P.sections[k].title)}</h3>${P.sections[k].caption ? `<div class="cap">${md(P.sections[k].caption)}</div>` : ''}</div>` : '';
  const tiles = P.tiles.map((t, i) => `<div class="card tile${t.hero ? ' hero' : ''}"><div class="label">${md(t.label)}</div><div class="value">${esc(fill(t.value))}${t.small ? `<small> ${esc(fill(t.small))}</small>` : ''}</div>${t.note ? `<div class="note">${md(t.note)}</div>` : ''}${t.subs ? `<dl class="subs">${t.subs.map(x => `<div><dt>${md(x.label)}</dt><dd>${esc(fill(x.value))}</dd></div>`).join('')}</dl>` : ''}</div>`).join('');
  const workflow = P.workflow ? `<section class="wf">${workflowSvg(P.workflow, rows, fill)}</section>` : '';
  const C = P.columns;
  // A column whose heading is null in the run file is left out.
  const COLS = [
    ['item', 'minmax(0,2.6fr)', r => `<a href="${esc(r.url)}"><b>${esc(r.label)}</b> ${esc(clip(r.title, 70))}</a>`],
    ['second', 'minmax(0,1fr)', r => `<span>${esc(word('second', r.second))}${r.secondNote ? ` <span class="muted small">(${esc(r.secondNote)})</span>` : ''}</span>`],
    ['outcome', '1fr', r => `<span>${chip(r.outcome)}</span>`],
    ['pr', '50px', r => `<span>${r.prNumber ? `<a href="${esc(r.prUrl)}">#${r.prNumber}</a>` : '—'}</span>`],
    ['proof', 'minmax(0,1.8fr)', r => `<span class="${r.proofFailed == null ? 'muted' : ''}">${esc(proof(r))}</span>`],
    ['time', '64px', r => `<span class="qc">${esc(r.timeText ?? '—')}</span>`],
    ['cost', '60px', r => `<span class="qc">${usd(r.cost)}</span>`],
  ].filter(([k]) => C[k] != null);
  const chip = o => `<span class="chip ${o === 'merged' ? 'ok' : o === 'ready' ? 'live' : ''}">${esc(word('outcome', o))}</span>`;
  const proof = r => r.proofFailed == null ? '—' : [(P.words?.proof ?? '{f} of {t}').replace('{f}', r.proofFailed).replace('{t}', r.proofTotal), ...r.tags.map(x => word('tags', x))].join(' · ');
  const head = `<div class="rrow rhead">${COLS.map(([k]) => `<span>${esc(C[k])}</span>`).join('')}</div>`;
  const rowsHtml = rows.map(r => `<div class="rrow">${COLS.map(([, , cell]) => cell(r)).join('')}</div>`).join('');

  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const timed = rows.filter(r => r.time != null), costed = rows.filter(r => r.cost != null);
  const tMed = med(timed.map(r => r.time)), cMed = med(costed.map(r => r.cost));
  const medianWord = esc(P.words?.median ?? 'median');
  const timeChart = timed.length ? bars(timed.map(r => ({ label: `${r.label} ${r.title}`, v: r.time, tip: [r.timeText] })), { fmt: v => String(Math.round(v)), unit: ' min', refLine: tMed, refLabel: `${medianWord} ${Math.round(tMed)} min` }) : '';
  const costChart = costed.length ? bars(costed.map(r => ({ label: `${r.label} ${r.title}`, v: r.cost, tip: [usd(r.cost)] })), { fmt: v => usd(v), refLine: cMed, refLabel: `${medianWord} ${usd(cMed)}` }) : '';
  const notes = (P.notes || []).map(n => `<div class="learn"><b>${md(n.title)}</b><p>${md(n.body)}</p></div>`).join('');


  const html = `<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(fill(P.title))}</title>
<style>${STYLE}
.tiles{grid-template-columns:repeat(${P.tiles.length},1fr)}
.sechead{margin:30px 2px 12px;padding-top:0}.sechead:first-of-type{margin-top:8px}.sechead h3{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--s1);font-weight:600}.sechead .cap{margin:4px 0 0}
.subs{margin:12px 0 0;border-top:1px solid var(--line)}.subs div{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px}.subs div:last-child{border-bottom:0}.subs dt{color:var(--ink2)}.subs dd{margin:0;white-space:nowrap;font-weight:600;font-variant-numeric:tabular-nums}.tile.hero .subs,.tile.hero .subs div{border-color:rgba(255,255,255,.14)}.tile.hero .subs dt{color:#b9b9f9}.tile.hero .subs dd{color:#fff}
.rrow{display:grid;grid-template-columns:${COLS.map(([, w]) => w).join(' ')};gap:12px;align-items:center;padding:9px 2px;border-top:1px solid var(--line);font-size:13px}.rrow a{color:var(--ink);text-decoration:none}.rrow a:hover{text-decoration:underline}.rrow.rhead{border-top:0;color:var(--muted);font-size:11.5px;padding-top:2px}
.learn{padding:9px 0;border-top:1px solid var(--line)}.learn:first-child{border-top:0}.learn b{font-weight:600;font-size:13.5px}.learn p{margin:3px 0 0;color:var(--ink2);font-size:13px}.learn a{color:var(--s1)}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2)}
.wf{margin-bottom:14px}.wf-svg{border-radius:14px;box-shadow:var(--shadow)}.wf-svg text{font-family:inherit}
.wf-svg{--wf-canvas:#fbfcfd;--wf-bg:#fff;--wf-stroke:#cfd5dc;--wf-box:#f4f6f8;--wf-muted:#6b7480;--wf-text:#1f2328;--wf-accent:#533afd;--wf-accent-soft:#eeebff;--wf-warn:#b26a00;--wf-warn-soft:#fff1d6;--wf-ok:#1f7a4d;--wf-ok-soft:#e3f4ea;--wf-dotc:#dde2e8}
[data-theme=dark] .wf-svg{--wf-canvas:#0a1d31;--wf-bg:#0d2238;--wf-stroke:#2a4563;--wf-box:#12304d;--wf-muted:#8ea3bd;--wf-text:#eef2f8;--wf-accent:#8b80ff;--wf-accent-soft:#1f2a55;--wf-warn:#f0b35a;--wf-warn-soft:#33260f;--wf-ok:#5fcf8e;--wf-ok-soft:#12291c;--wf-dotc:#18324d}
.wf-canvas{fill:var(--wf-canvas);stroke:var(--wf-stroke)}.wf-dotgrid{fill:var(--wf-dotc)}
.wf-cardbg{fill:var(--wf-bg);stroke:var(--wf-stroke)}.wf-foot{fill:var(--wf-box)}.wf-tick{stroke:var(--wf-stroke)}
.wf-tile{fill:var(--wf-box)}.wf-tile.accent{fill:var(--wf-accent-soft)}.wf-tile.ok{fill:var(--wf-ok-soft)}
.wf-glyph{fill:none;stroke:var(--wf-muted);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.wf-g.accent .wf-glyph{stroke:var(--wf-accent)}.wf-g.ok .wf-glyph{stroke:var(--wf-ok)}.wf-glyphfill{fill:var(--wf-accent)}
.wf-dot{fill:var(--wf-muted)}.wf-dot.accent{fill:var(--wf-accent)}.wf-dot.ok{fill:var(--wf-ok)}
.wf-h{font-size:15px;font-weight:650;fill:var(--wf-text)}.wf-s{font-size:12px;fill:var(--wf-muted)}.wf-m{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--wf-muted)}
.wf-c{font-weight:700;fill:var(--wf-text)}.wf-halo{paint-order:stroke;stroke:var(--wf-canvas);stroke-width:5px;stroke-linejoin:round}
.wf-edge{fill:none;stroke:var(--wf-muted);stroke-width:1.5}.wf-edge.warn{stroke:var(--wf-warn);stroke-dasharray:5 4}.wf-edge.dashed{stroke-dasharray:5 4}.wf-edge.dotted{stroke:var(--wf-accent);stroke-dasharray:2 4}
.wf-ah{fill:var(--wf-muted)}.wf-ah.warn{fill:var(--wf-warn)}.wf-gate{fill:var(--wf-warn-soft);stroke:var(--wf-warn)}
.wf-pill{fill:var(--wf-box)}.wf-pill.on{fill:var(--wf-accent-soft)}.wf-pilltext{font-size:12.5px;font-weight:600;fill:var(--wf-muted)}.wf-pilltext.on{fill:var(--wf-accent)}
.wf-chip rect{fill:var(--wf-bg);stroke:var(--wf-stroke)}.wf-chip text{font-size:11px;font-weight:600;fill:var(--wf-accent)}.wf-chip:hover rect{stroke:var(--wf-accent)}
</style>
<div class="wrap">
<header><div><div class="eyebrow">${md(P.eyebrow)}</div><h1>${md(P.title)}</h1><div class="sub">${md(P.subtitle)}</div></div>
<div class="right"><div id="theme-switch" role="group" aria-label="Theme"></div><div class="pill">${esc(P.words?.recorded ?? 'Recorded')} <b>${dmhm(frozenAt)}</b></div></div></header>
${sec('metrics')}<section class="tiles">${tiles}</section>
${sec('workflow')}${workflow}
${sec('results')}<section class="card"><h2>${md(P.table.title)}</h2><div class="cap">${md(P.table.caption)}</div>${head}${rowsHtml}</section>
<div class="grid2">
<section class="card"><h2>${md(P.charts.time.title)}</h2><div class="cap">${md(P.charts.time.caption)}</div>${timeChart}</section>
<section class="card"><h2>${md(P.charts.cost.title)}</h2><div class="cap">${md(P.charts.cost.caption)}</div>${costChart}</section>
</div>
${notes ? `<section class="card" style="margin-top:14px"><h2>${md(P.notesTitle)}</h2>${notes}</section>` : ''}
<footer>${md(P.footer)}</footer>
</div>
<div id="tip"></div>
${SCRIPT}`;
  const out = dataFile.replace(/\.json$/, '.html');
  fs.writeFileSync(out, html);
  return out;
}

if (import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: render-run.mjs results/<run>.json'); process.exit(2); }
  console.log(renderRun(path.resolve(file)));
}
