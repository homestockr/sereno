'use strict';
/*
 * Sereno console: Spend tab. Plain JS, no framework. Reads /api/spend/* only.
 * Pure helpers come first (tests lift them from source by name, so each one is a
 * top-level `function` whose closing brace is the first `}` at column 0).
 * Privacy: no prompt text exists here or in the API; every API string goes
 * through esc() before it reaches markup, and setHtml() is the only innerHTML write.
 */

/* ---------- pure helpers ---------- */

/** Integer micros in, '$12.34 est.' out. Same behaviour as estMoney in src/renderer/app.js. */
function estMoney(micros) {
  const n = Number(micros);
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return '$' + (v / 1e6).toFixed(2) + ' est.';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Integer percents that sum to exactly 100 (all 0 when there is nothing to split). */
function largestRemainder(values) {
  const v = values.map((x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0));
  const sum = v.reduce((a, b) => a + b, 0);
  if (sum <= 0) return v.map(() => 0);
  const exact = v.map((x) => (x / sum) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  exact.map((x, i) => ({ i, f: x - Math.floor(x) }))
    .sort((a, b) => (b.f - a.f) || (a.i - b.i))
    .forEach((e) => { if (left > 0) { out[e.i] += 1; left -= 1; } });
  return out;
}

/** 3 or 4 increasing dollar ticks starting at 0 and covering maxMicros. */
function niceTicks(maxMicros) {
  const n = Number(maxMicros);
  const max = Number.isFinite(n) && n > 0 ? n / 1e6 : 0;
  if (max === 0) return [0, 1, 2, 3];
  const exp = Math.floor(Math.log10(max));
  for (let e = Math.max(exp - 1, -2); e <= exp + 1; e++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * Math.pow(10, e);
      if (max <= step * 3 + 1e-9) {
        const cnt = Math.max(2, Math.ceil(max / step - 1e-9));
        const out = [];
        for (let i = 0; i <= cnt; i++) out.push(Number((i * step).toFixed(6)));
        return out;
      }
    }
  }
  return [0, 1, 2, 3];
}

function tickLabel(dollars) {
  return '$' + (Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2));
}

/**
 * One bucket as stacked segments, bottom to top: Main, Subagent, Auxiliary, then the
 * unattributed share. Unattributed is an overlay on source in the ledger, so it is
 * carved out of the sources (subagent first) and anything the sources do not explain
 * also lands in it. Micros always sum to the bucket total.
 */
function segmentsOf(b) {
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const bk = b || {};
  const src = bk.bySource || {};
  const m = { main: num(src.main), subagent: num(src.subagent), auxiliary: num(src.auxiliary) };
  const known = m.main + m.subagent + m.auxiliary;
  const total = Math.max(num(bk.costMicros), known);
  let left = Math.min(num((bk.byAttribution || {}).unknown), total);
  for (const k of ['subagent', 'main', 'auxiliary']) {
    const take = Math.min(m[k], left);
    m[k] -= take; left -= take;
  }
  const attributed = m.main + m.subagent + m.auxiliary;
  return [
    { key: 'main', micros: m.main },
    { key: 'subagent', micros: m.subagent },
    { key: 'auxiliary', micros: m.auxiliary },
    { key: 'unattributed', micros: Math.max(0, total - attributed) },
  ];
}

/**
 * Bars for a w x h plot: per bucket { key, x, w, total, segs:[{ key, micros, x, y, w, h }] }.
 * Segment heights sum to total scaled to maxMicros; y grows downward from 0 (top).
 * Empty data gives zero heights, never NaN.
 */
function barGeometry(buckets, w, h, maxMicros) {
  const list = Array.isArray(buckets) ? buckets : [];
  const W = Number.isFinite(Number(w)) && Number(w) > 0 ? Number(w) : 0;
  const H = Number.isFinite(Number(h)) && Number(h) > 0 ? Number(h) : 0;
  const mx = Number.isFinite(Number(maxMicros)) && Number(maxMicros) > 0 ? Number(maxMicros) : 0;
  const slot = list.length ? W / list.length : 0;
  const bw = slot > 0 ? Math.max(1, slot * 0.68) : 0;
  const scale = mx > 0 ? H / mx : 0;
  return list.map((b, i) => {
    const x = i * slot + (slot - bw) / 2;
    let cursor = H;
    const segs = segmentsOf(b).map((s) => {
      const sh = s.micros * scale;
      cursor -= sh;
      return { key: s.key, micros: s.micros, x, y: cursor, w: bw, h: sh };
    });
    return { key: b && b.key, x, w: bw, total: segs.reduce((a, s) => a + s.micros, 0), segs };
  });
}

/** `$X est. today · $Y est. this month · Z% unattributed (n=N)` */
function summaryLine(today, projects) {
  const rows = (projects && Array.isArray(projects.rows)) ? projects.rows : [];
  const month = rows.reduce((a, r) => a + (Number(r.costMicros) > 0 ? Number(r.costMicros) : 0), 0);
  const un = (projects && projects.unattributed) || {};
  const unCost = Number(un.costMicros) > 0 ? Number(un.costMicros) : 0;
  const n = Number(un.requests) > 0 ? Number(un.requests) : 0;
  const pct = month > 0 ? Math.round((unCost / month) * 100) : 0;
  return estMoney(today && today.costMicros) + ' today · ' + estMoney(month) + ' this month · '
    + pct + '% unattributed (n=' + n + ')';
}

/** Explicit vs unattributed share of one project's spend, summing to 100. */
function attributionSplit(byAttribution, requests) {
  const a = byAttribution || {};
  const p = largestRemainder([a.explicit, a.unknown]);
  const n = Number(requests) > 0 ? Number(requests) : 0;
  return { explicitPct: p[0], unattributedPct: p[1], n };
}

/** Local 'Mon DD HH:MM'. */
function formatTime(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const p2 = (x) => String(x).padStart(2, '0');
  return mon + ' ' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function projectLabel(project) {
  return project == null || project === '' ? 'Unknown project' : String(project);
}

/** 'Synced just now' / 'Synced 40s ago' / 'Synced 3m ago'. */
function syncLabel(lastOkMs, nowMs) {
  if (lastOkMs == null || !Number.isFinite(Number(lastOkMs))) return 'Not synced yet';
  const s = Math.max(0, Math.floor((Number(nowMs) - Number(lastOkMs)) / 1000));
  if (s < 5) return 'Synced just now';
  if (s < 60) return 'Synced ' + s + 's ago';
  return 'Synced ' + Math.floor(s / 60) + 'm ago';
}

/** Sparkline polyline points for a w x h box; flat line when there is no variation. */
function sparkPoints(values, w, h) {
  const v = (Array.isArray(values) ? values : []).map((x) => (Number(x) > 0 ? Number(x) : 0));
  if (!v.length) return '';
  const mx = Math.max.apply(null, v);
  const step = v.length > 1 ? w / (v.length - 1) : 0;
  return v.map((x, i) => {
    const y = mx > 0 ? h - 2 - (x / mx) * (h - 4) : h - 2;
    return (i * step).toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}

/** Which full-page state the four responses call for, or null to render the data. */
function pageState(resps) {
  const list = (resps || []).filter(Boolean);
  if (list.some((r) => r.status === 503 || r.status === 0 || !r.body)) return 'unavailable';
  if (list.some((r) => r.body.enabled === false)) return 'off';
  return null;
}

/** Singular/plural text for the amber pill next to the page title. */
function pillText(count) {
  const n = Number(count) > 0 ? Math.floor(Number(count)) : 0;
  return n === 1 ? '1 decision needs you' : n + ' decisions need you';
}

/**
 * What /state says needs the user. Amber iff a top-level session is 'blocked' (the store
 * only sets that from a permission_prompt notification); nothing else is re-derived.
 * Tagged subagent rows never count.
 */
function attentionState(snapshot) {
  const list = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const items = list
    .filter((s) => s && typeof s === 'object' && s.state === 'blocked' && !s.agent_id && !s.agentId)
    .map((s) => ({
      project: projectLabel(s.projectName),
      tool: typeof s.stateTool === 'string' ? s.stateTool : '',
      arg: typeof s.stateArgShort === 'string' ? s.stateArgShort : '',
      since: Number.isFinite(Number(s.stateSince)) && Number(s.stateSince) > 0 ? Number(s.stateSince) : null,
    }));
  return { amber: items.length > 0, count: items.length, items };
}

/** 'waiting 3m' / 'waiting 45s'; '' when the start time is unknown. */
function waitLabel(since, nowMs) {
  if (since == null || !Number.isFinite(Number(since))) return '';
  const s = Math.max(0, Math.floor((Number(nowMs) - Number(since)) / 1000));
  if (s < 60) return 'waiting ' + s + 's';
  if (s < 3600) return 'waiting ' + Math.floor(s / 60) + 'm';
  return 'waiting ' + Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

/** Question-ring icon: a shape, so the state reads without colour. */
function ringIcon() {
  return '<svg class="q-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M6.2 6.3c0-1.9 3.6-1.9 3.6 0 0 1.3-1.8 1.4-1.8 2.6M8 11.1v.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}

/** Amber pill markup, or '' when nothing needs the user. */
function pillHtml(count) {
  return Number(count) > 0 ? '<span class="pill-amber">' + ringIcon() + esc(pillText(count)) + '</span>' : '';
}

/** 'Bash npm test' style detail, escaped; '' when /state gave neither. */
function waitWhat(it) {
  return [it.tool, it.arg].filter(Boolean).map(esc).join(' ');
}

/**
 * Attention panel markup. Input is attentionState() output, or { unavailable: true } when
 * /state could not be read (neutral grey, never amber). Every API string goes through esc().
 */
function attentionHtml(st, nowMs) {
  if (!st || st.unavailable) {
    return '<div class="attn attn-off"><div class="attn-head"><span>LIVE STATUS</span></div>'
      + '<h2 class="attn-title">Live status unavailable</h2></div>';
  }
  if (!st.amber) {
    return '<div class="attn attn-calm"><div class="attn-head"><i class="dot" aria-hidden="true"></i><span>ALL CLEAR</span></div>'
      + '<p class="attn-body">Nothing needs you right now.</p></div>';
  }
  const items = Array.isArray(st.items) ? st.items : [];
  const title = items.length === 1
    ? esc(items[0].project) + ' is waiting for permission.'
    : st.count + ' sessions are waiting for permission.';
  let list = '';
  if (items.length > 1) {
    list = '<ul class="attn-list">' + items.map((it) => {
      const what = waitWhat(it);
      const w = waitLabel(it.since, nowMs);
      return '<li><strong>' + esc(it.project) + '</strong>' + (what ? '<span class="mono">' + what + '</span>' : '')
        + (w ? '<span class="wait">' + esc(w) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  } else if (items.length === 1) {
    const what = waitWhat(items[0]);
    const w = waitLabel(items[0].since, nowMs);
    if (what) list += '<div class="attn-what mono">' + what + '</div>';
    if (w) list += '<div class="wait">' + esc(w) + '</div>';
  }
  return '<div class="attn attn-amber"><div class="attn-head">' + ringIcon() + '<span>NEEDS YOUR ATTENTION</span></div>'
    + '<h2 class="attn-title">' + title + '</h2>' + list
    + '<p class="attn-body">Answer it in the terminal. Sereno only points you there.</p></div>';
}

/* ---------- state ---------- */

const RANGES = ['24h', '7d', '30d'];
const SRC_LABEL = { main: 'Main', subagent: 'Subagent', auxiliary: 'Auxiliary', unattributed: 'Unattributed' };
const ATTR_LABEL = { explicit: 'Explicit', unknown: 'Unattributed', mixed: 'Mixed' };

const state = {
  range: '30d', today: null, series: null, projects: null, top: null,
  mode: 'loading', lastOk: null, token: 0,
  attn: null, attnToken: 0,   // attn: attentionState() output, { unavailable: true }, or null before the first read
};

function loadRange() {
  try {
    const r = localStorage.getItem('sereno.console.range');
    if (RANGES.indexOf(r) >= 0) state.range = r;
  } catch (_) { /* storage can be blocked */ }
}
function saveRange(r) {
  try { localStorage.setItem('sereno.console.range', r); } catch (_) { /* ignore */ }
}

/* ---------- rendering ---------- */

function setHtml(el, html) { el.innerHTML = html; }

/* CSP is style-src 'self': no inline style attributes in markup; sizes go through CSSOM. */
function applyWidths(root) {
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = Number(el.getAttribute('data-w')) + '%'; });
}

function sw(key) { return '<i class="swatch seg-' + key + '"></i>'; }

function dayLabel(ms) {
  const d = new Date(ms);
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate();
}

function chartSvg(series, width) {
  const buckets = (series && series.buckets) || [];
  const hourly = series && series.range === '24h';
  const W = Math.max(320, Math.floor(width) || 640);
  const padL = 46, padR = 6, padT = 22, padB = 22, plotH = 170;
  const plotW = W - padL - padR;
  const totals = buckets.map((b) => segmentsOf(b).reduce((a, s) => a + s.micros, 0));
  const maxData = totals.length ? Math.max.apply(null, totals) : 0;
  const ticks = niceTicks(maxData);
  const top = ticks[ticks.length - 1] * 1e6;
  const geo = barGeometry(buckets, plotW, plotH, top);
  let g = '<text x="0" y="10">USD · estimated</text>';
  ticks.forEach((t) => {
    const y = padT + plotH - (t * 1e6 / top) * plotH;
    g += '<line class="' + (t === 0 ? 'base' : 'grid') + '" x1="' + padL + '" x2="' + (padL + plotW) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line>'
      + '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(tickLabel(t)) + '</text>';
  });
  geo.forEach((b, i) => {
    const bk = buckets[i];
    const label = hourly
      ? dayLabel(bk.since) + ' ' + String(new Date(bk.since).getHours()).padStart(2, '0') + ':00'
      : dayLabel(bk.since);
    const tipLines = [label + ' · ' + estMoney(b.total)].concat(
      b.segs.filter((s) => s.micros > 0).map((s) => SRC_LABEL[s.key] + ' ' + estMoney(s.micros)));
    let bars = '';
    b.segs.forEach((s) => {
      if (s.h <= 0) return;
      bars += '<rect class="' + (s.key === 'unattributed' ? 'bar-hatch' : 'bar-' + s.key) + '" x="' + (padL + s.x).toFixed(1)
        + '" y="' + (padT + s.y).toFixed(1) + '" width="' + s.w.toFixed(1) + '" height="' + s.h.toFixed(1) + '"></rect>';
    });
    // transparent hit area so empty and thin bars still show a tooltip
    bars += '<rect fill="transparent" x="' + (padL + b.x - 1).toFixed(1) + '" y="' + padT + '" width="' + (b.w + 2).toFixed(1) + '" height="' + plotH + '"></rect>';
    g += '<g><title>' + esc(tipLines.join('\n')) + '</title>' + bars + '</g>';
    const every = hourly ? 6 : 5;
    if (i % every === 0) {
      const lx = padL + b.x + b.w / 2;
      g += '<text x="' + lx.toFixed(1) + '" y="' + (padT + plotH + 16) + '" text-anchor="middle">'
        + esc(hourly ? String(new Date(bk.since).getHours()).padStart(2, '0') + ':00' : dayLabel(bk.since)) + '</text>';
    }
  });
  const H = padT + plotH + padB;
  return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Estimated spend by source, '
    + esc(series ? series.range : '') + '">' + g + '</svg>' + (maxData > 0 ? '' : '<div class="chart-empty">No spend in this range</div>');
}

function legendHtml() {
  return ['main', 'subagent', 'auxiliary', 'unattributed']
    .map((k) => '<span class="item">' + sw(k) + esc(SRC_LABEL[k]) + '</span>').join('');
}

function chartTitle(range) {
  const hourly = range === '24h';
  return { title: hourly ? 'Hourly usage cost' : 'Daily usage cost', sub: (hourly ? 'hourly' : 'daily') + ' · estimated' };
}

function chartSection() {
  const toggle = RANGES.map((r) => '<button type="button" data-range="' + r + '" class="' + (r === state.range ? 'on' : '')
    + '" aria-pressed="' + (r === state.range) + '">' + r + '</button>').join('');
  const t = chartTitle(state.range);
  return '<div class="section-top"><h2><span id="chart-title">' + t.title + '</span><span class="sub" id="chart-sub">' + t.sub + '</span></h2>'
    + '<div class="legend">' + legendHtml() + '</div><div class="range" role="group" aria-label="Range">' + toggle + '</div></div>'
    + '<div class="chart-box" id="chart-box"></div>';
}

function drawChart() {
  const box = document.getElementById('chart-box');
  if (!box || !state.series) return;
  setHtml(box, chartSvg(state.series, box.clientWidth));
}

function projectsSection() {
  const p = state.projects;
  const rows = (p.rows || []).slice().sort((a, b) => b.costMicros - a.costMicros);
  const month = rows.reduce((a, r) => a + (Number(r.costMicros) > 0 ? Number(r.costMicros) : 0), 0);
  const un = p.unattributed || { costMicros: 0, requests: 0 };
  const money = (x) => '<span class="num">' + esc(estMoney(x)) + '</span>';
  const body = rows.map((r) => {
    const s = r.bySource || {};
    const a = attributionSplit(r.byAttribution, r.requests);
    const aria = a.explicitPct + '% explicit, ' + a.unattributedPct + '% unattributed, n=' + a.n;
    return '<tr><td class="proj">' + esc(projectLabel(r.project)) + '</td>'
      + '<td>' + money(s.main) + '</td><td>' + money(s.subagent) + '</td><td>' + money(s.auxiliary) + '</td>'
      + '<td><strong class="num">' + esc(estMoney(r.costMicros)) + '</strong></td>'
      + '<td><div class="attr" role="img" aria-label="' + esc(aria) + '"><div class="attr-bar">'
      + '<span class="seg-main" data-w="' + a.explicitPct + '"></span>'
      + '<span class="seg-unattributed" data-w="' + a.unattributedPct + '"></span></div>'
      + '<div class="attr-line">' + a.explicitPct + '% / ' + a.unattributedPct + '% · n=' + a.n + '</div></div></td>'
      + '<td><svg class="spark" viewBox="0 0 110 25" aria-hidden="true"><polyline points="' + sparkPoints(r.trend, 110, 25) + '"></polyline></svg></td></tr>';
  }).join('');
  const unPct = month > 0 ? Math.round((Number(un.costMicros) / month) * 100) : 0;
  return '<div class="section-top"><h2>Projects × source<span class="sub">Month to date</span></h2>'
    + '<div class="legend"><span class="item"><i class="swatch seg-main"></i>Explicit</span><span class="item">' + sw('unattributed') + 'Unattributed</span></div></div>'
    + '<div class="table-wrap"><table class="proj-table"><thead><tr><th>Project</th><th>Main</th><th>Subagent</th><th>Auxiliary</th><th>Total</th><th>Attribution</th><th>14d trend</th></tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>'
    + '<div class="unattr-row">' + sw('unattributed') + '<strong>Unattributed</strong>' + money(un.costMicros)
    + '<span>No subagent could be confirmed for these requests.</span>'
    + '<span class="right">Included in project totals · ' + unPct + '% (n=' + (Number(un.requests) || 0) + ' requests)</span></div>';
}

function promptsSection() {
  const rows = (state.top && state.top.rows) || [];
  const body = rows.map((r, i) => '<tr><td class="rank">' + String(i + 1).padStart(2, '0') + '</td>'
    + '<td class="num">' + esc(formatTime(r.ts)) + '</td>'
    + '<td>' + esc(projectLabel(r.project)) + '</td>'
    + '<td class="mono">' + esc(r.sessionShort) + '</td>'
    + '<td class="num">' + esc(estMoney(r.costMicros)) + '</td>'
    + '<td>' + esc((r.models || []).join(', ')) + '</td>'
    + '<td>' + esc(ATTR_LABEL[r.attribution] || 'Unattributed') + '</td></tr>').join('');
  return '<div class="section-top prompts-head"><h2>Top 10 costliest prompts<span class="sub">Month to date</span></h2>'
    + '<span class="sub">Prompt text is never stored</span></div>'
    + '<div class="table-wrap prompts"><table><thead><tr><th>#</th><th>Time</th><th>Project</th><th>Session</th><th>Estimated cost</th><th>Model</th><th>Attribution</th></tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>';
}

function titleRow() {
  return '<div class="title-row"><h1>Spend</h1><span id="pill-slot">' + pillHtml(state.attn && state.attn.amber ? state.attn.count : 0) + '</span></div>';
}

function renderAttention() {
  const box = document.getElementById('attn');
  if (box) setHtml(box, attentionHtml(state.attn || { amber: false, count: 0, items: [] }, Date.now()));
  const slot = document.getElementById('pill-slot');
  if (slot) setHtml(slot, pillHtml(state.attn && state.attn.amber ? state.attn.count : 0));
}

function panel(title, text) {
  return titleRow() + '<div class="state-panel"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
}

function render() {
  const view = document.getElementById('view');
  const side = document.getElementById('side-today');
  view.setAttribute('aria-busy', state.mode === 'loading' ? 'true' : 'false');
  if (state.mode === 'loading') { setHtml(view, ''); setHtml(side, ''); return; }
  if (state.mode === 'off') {
    setHtml(side, '');
    setHtml(view, panel('Spend history is off', 'Turn it on from the Sereno tray: Keep spend history.'));
    return;
  }
  if (state.mode === 'unavailable') {
    setHtml(side, '');
    setHtml(view, panel('Spend history is unavailable right now', 'Sereno will try again on the next refresh.'));
    return;
  }
  setHtml(side, esc(estMoney(state.today.costMicros)) + ' today');
  const monthRequests = ((state.projects.rows) || []).reduce((a, r) => a + (Number(r.requests) || 0), 0);
  if (!(Number(state.today.requests) > 0) && monthRequests === 0) {
    setHtml(view, panel('No spend recorded yet', 'Spend appears once Claude Code sessions send telemetry. Wire it from the tray: Wire telemetry…'));
    return;
  }
  setHtml(view, titleRow() + '<p class="summary">' + esc(summaryLine(state.today, state.projects)) + '</p>'
    + chartSection() + projectsSection() + promptsSection());
  applyWidths(view);
  drawChart();
}

/* ---------- data ---------- */

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body: r.ok ? body : null };
  } catch (_) {
    return { status: 0, body: null };
  }
}

async function refreshAttention() {
  const token = ++state.attnToken;
  const r = await getJson('/state');
  if (token !== state.attnToken) return;
  state.attn = r.body && Array.isArray(r.body.sessions) ? attentionState(r.body) : { unavailable: true };
  renderAttention();
}

async function refresh() {
  refreshAttention();
  const token = ++state.token;
  const [today, series, projects, top] = await Promise.all([
    getJson('/api/spend/today'),
    getJson('/api/spend/series?range=' + state.range),
    getJson('/api/spend/projects?range=month'),
    getJson('/api/spend/top-prompts?range=month'),
  ]);
  if (token !== state.token) return;   // a newer refresh superseded this one
  const bad = pageState([today, series, projects, top]);
  if (bad) { state.mode = bad; render(); return; }
  state.today = today.body; state.series = series.body; state.projects = projects.body; state.top = top.body;
  state.mode = 'data';
  state.lastOk = Date.now();
  render();
  tickSync();
}

async function refreshSeries() {
  const token = ++state.token;
  const r = await getJson('/api/spend/series?range=' + state.range);
  if (token !== state.token) return;
  const bad = pageState([r]);
  if (bad) { state.mode = bad; render(); return; }
  state.series = r.body;
  state.lastOk = Date.now();
  drawChart();
  tickSync();
}

function tickSync() {
  const el = document.getElementById('sync');
  if (el) el.textContent = syncLabel(state.lastOk, Date.now());
}

/* ---------- boot ---------- */

function boot() {
  loadRange();
  const host = document.getElementById('foot-host');
  if (host) host.textContent = location.host + '/console';
  document.getElementById('view').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-range]') : null;
    if (!b) return;
    const r = b.getAttribute('data-range');
    if (RANGES.indexOf(r) < 0 || r === state.range) return;
    state.range = r; saveRange(r);
    document.querySelectorAll('.range button').forEach((x) => {
      const on = x.getAttribute('data-range') === r;
      x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on));
    });
    const t = chartTitle(r);
    const ti = document.getElementById('chart-title'), su = document.getElementById('chart-sub');
    if (ti) ti.textContent = t.title;
    if (su) su.textContent = t.sub;
    refreshSeries();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
  // While amber, poll faster so a resolved wait clears promptly.
  setInterval(() => { if (document.visibilityState === 'visible' && state.attn && state.attn.amber) refreshAttention(); }, 10000);
  setInterval(tickSync, 10000);
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawChart(); });
  });
  render();
  refresh();   // also reads /state; the panel stays empty until it answers
}

if (typeof document !== 'undefined') boot();
