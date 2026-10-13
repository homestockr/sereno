'use strict';
/*
 * Sereno renderer. Consumes the collector's SSE stream.
 *
 * The waiting timer ticks on this page's own clock, never on event arrival: the
 * statusline stops firing while a session sits on a permission prompt (see
 * docs/payloads.md), so an event-driven timer would freeze exactly when the user
 * most needs it to move.
 */

const MAX_ROWS = 4;
const api = window.sereno || null;

const el = (id) => document.getElementById(id);
const ui = {
  window: el('window'), banner: el('banner'),
  headline: el('headline'), title: el('headline-title'), sub: el('headline-sub'),
  alertHeading: el('alert-heading'), alertTitle: el('alert-title'),
  request: el('request'), reqProject: el('request-project'), reqTimer: el('request-timer'),
  reqDesc: el('request-desc'), reqCommand: el('request-command'), reqMeta: el('request-meta'),
  review: el('review'), reviewNote: el('review-note'),
  rows: el('rows'), footer: el('footer'),
  usageWindows: el('usage-windows'), usageNote: el('usage-note'), usageCost: el('usage-cost'),
  offline: el('offline'), grip: el('size-grip'),
  setup: el('setup'), setupBody: el('setup-body'), setupAction: el('setup-action'),
  setupActionLabel: el('setup-action-label'), setupNote: el('setup-note'),
  settingsToggle: el('settings-toggle'), collapse: el('collapse'),
  autoLaunchRow: el('autolaunch-row'), autoLaunch: el('autolaunch'),
  briefRow: el('brief-row'), briefStatus: el('brief-status'), briefAction: el('brief-action'),
  spend: el('spend'), consoleLine: el('console-line'),
};

// null until the first status check; only false means "definitely not wired".
let wired = null;

let snapshot = { sessions: [], totalCost: 0, windows: {}, counts: { total: 0, blocked: 0, active: 0, quiet: 0 } };
let expanded = false;

/* ---------- formatting ---------- */

const money = (v) => '$' + Number(v || 0).toFixed(2);

/* ---------- spend (Today block) ---------- */

/** Integer micros in, '$12.34 est.' out. Every dollar figure carries its label. */
function estMoney(micros) {
  const n = Number(micros);
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return '$' + (v / 1e6).toFixed(2) + ' est.';
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

/**
 * Today's spend as bar segments: Main, Subagent, Auxiliary, then the unattributed
 * share last. Unattributed is an overlay on source in the ledger (those rows also
 * have a source), so it is carved out of the source segments, subagent first, to
 * keep the bar summing to the day's total. Zero segments are left out.
 */
function sourceSegments(spend) {
  const sp = spend || {};
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const src = sp.bySource || {};
  const m = { main: num(src.main), subagent: num(src.subagent), auxiliary: num(src.auxiliary) };
  const known = m.main + m.subagent + m.auxiliary;
  const un = Math.min(num((sp.byAttribution || {}).unknown), known);
  let left = un;
  for (const k of ['subagent', 'main', 'auxiliary']) {
    const take = Math.min(m[k], left);
    m[k] -= take; left -= take;
  }
  const segs = [
    { key: 'main', label: 'Main', micros: m.main },
    { key: 'subagent', label: 'Subagent', micros: m.subagent },
    { key: 'auxiliary', label: 'Auxiliary', micros: m.auxiliary },
    { key: 'unattributed', label: 'Unattributed', micros: un },
  ].filter((x) => x.micros > 0);
  const pcts = largestRemainder(segs.map((x) => x.micros));
  return segs.map((x, i) => Object.assign(x, { pct: pcts[i] }));
}

function barAriaLabel(segs) {
  if (!segs.length) return 'No estimated spend today';
  return 'Estimated spend today by source: '
    + segs.map((x) => x.label + ' ' + x.pct + '%, ' + estMoney(x.micros)).join('; ');
}

/**
 * Cumulative spend since local midnight as an SVG point list "x,y x,y ...".
 * Only buckets that start at or after midnight and before asOf count (the 24h
 * series reaches back before today). x is time of day across the local day,
 * y runs from h (nothing yet) up to 0 (today's total), never decreasing.
 */
function cumulativePoints(buckets, midnight, asOf, w, h) {
  const d = new Date(midnight);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const span = end - midnight;
  const xAt = (t) => Math.min(w, Math.max(0, ((t - midnight) / span) * w));
  const cost = (b) => (Number(b.costMicros) > 0 ? Number(b.costMicros) : 0);
  const rows = (buckets || [])
    .filter((b) => b && b.since >= midnight && b.since < asOf)
    .sort((a, b) => a.since - b.since);
  const total = rows.reduce((a, b) => a + cost(b), 0);
  const yAt = (c) => (total > 0 ? h - (c / total) * h : h);
  const pts = [[xAt(midnight), yAt(0)]];
  let cum = 0;
  for (const b of rows) {
    cum += cost(b);
    pts.push([xAt(Math.min(b.until, asOf)), yAt(cum)]);
  }
  return pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
}

/**
 * x of the "Now" marker: the real current time across the local day starting at
 * `midnight`, clamped to the day (a stale series must not push it off the chart).
 */
function nowMarkerX(now, midnight, w) {
  const d = new Date(midnight);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const x = ((now - midnight) / (end - midnight)) * w;
  return Number.isFinite(x) ? Math.min(w, Math.max(0, x)) : 0;
}

function setupCopy(st) {
  const n = st && st.hookCount;
  const what = Number.isInteger(n) && n > 0 ? 'a statusline and ' + n + ' hooks' : 'a statusline and its hooks';
  return st && st.foreignStatusLine
    ? 'Sereno adds ' + what + ' to Claude Code’s settings. You already have a statusline configured — connecting replaces it. Your settings file is backed up first.'
    : 'Sereno adds ' + what + ' to Claude Code’s settings. Existing entries are kept, and your settings file is backed up first.';
}

function mmss(ms) {
  // Math.max(0, NaN) is NaN, which used to reach the DOM as the string
  // "NaN:NaN" and repaint twice a second forever.
  if (!Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function humanMinutes(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute';
  return m + (m === 1 ? ' minute' : ' minutes');
}

function untilReset(epochSeconds) {
  if (!epochSeconds) return '';
  const secs = epochSeconds - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'Resetting now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  // Days matter once the 7-day window is on screen: it would otherwise count
  // down from 'Resets in 167h 59m', which nobody can read at a glance.
  if (d) return 'Resets in ' + d + 'd ' + h + 'h';
  if (h) return 'Resets in ' + h + 'h ' + String(m).padStart(2, '0') + 'm';
  return 'Resets in ' + m + 'm';
}

/*
 * The rate-limit windows, in the order they should be read rather than the order
 * the payload happens to list them in. Anything unrecognised is shown after
 * these, so a new window Anthropic adds appears by itself instead of silently
 * going missing.
 *
 * Only these two have ever been observed. A per-model figure - the Fable weekly
 * allowance the desktop app shows - is NOT in the statusline payload, and there
 * is nothing here to derive it from, so it is not displayed rather than guessed.
 */
const WINDOW_ORDER = ['five_hour', 'seven_day'];
const WINDOW_LABELS = {
  five_hour: '5-hour session',
  seven_day: '7-day weekly',
};

function windowLabel(key) {
  return WINDOW_LABELS[key] || key.replace(/_/g, ' ');
}

function orderedWindows(windows) {
  const known = WINDOW_ORDER.filter((k) => windows[k]);
  const rest = Object.keys(windows).filter((k) => !WINDOW_ORDER.includes(k)).sort();
  return known.concat(rest);
}

/** Stale is a presentation state: it overrides whatever the session was doing. */
function stateLabel(s) {
  // Blocked outranks stale. Waiting on you is not inactivity - we know exactly
  // what it is doing - and the longest waits are the ones promoted to the top,
  // where calling them 'Stale' with no beacon is precisely backwards.
  if (s.stale && s.state !== 'blocked') return 'Stale';
  // Idle with subagents still working in the background (they can outlive the
  // parent's Stop): presentation only, the store state stays 'idle'. Inlined,
  // not a helper, because the tests lift these functions out one by one.
  if (s.state === 'idle' && s.subagents > 0) return 'Running';
  return s.state.charAt(0).toUpperCase() + s.state.slice(1);
}

function activityText(s) {
  if (s.stale && s.state !== 'blocked') return 'No activity for ' + humanMinutes(s.staleForMs);
  if (s.state === 'idle' && s.subagents > 0) return 'Background work · ready for your next prompt';
  switch (s.state) {
    case 'running':
      return s.stateTool ? s.stateTool + (s.stateArgShort ? ' · ' + s.stateArgShort : '') : 'Working';
    case 'thinking':   return 'Reasoning before the next step';
    case 'compacting': return 'Making room in context';
    case 'blocked':    return 'Waiting for approval';
    default:           return 'Ready for your next prompt';
  }
}

function symbolFor(s) {
  const label = stateLabel(s).toLowerCase();
  if (label === 'running') return '<i></i><i></i><i></i>';
  if (label === 'compacting') return '↔';
  if (label === 'blocked') return '!';
  return '';
}

function metaHtml(s) {
  const ctx = typeof s.contextPct === 'number'
    ? `<span class="context"><span class="context-track" aria-hidden="true"><i data-w="${s.contextPct}"></i></span>Context ${s.contextPct}%</span>`
    : '<span class="context">Context —</span>';
  const cost = typeof s.costUsd === 'number' ? money(s.costUsd) + ' est.' : '';
  return `<div class="meta">${ctx}<span>${cost}</span></div>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One line per live subagent: which agent it is, what it is running, how long
 * it has been going.
 *
 * "How long" counts from the first tagged event we saw (SubagentStart, where
 * Claude Code sends one, is just that first event; 2.1.270 sends none) - the
 * earliest moment the subagent is knowable. A subagent seeded from a Stop's
 * background_tasks counts from when that Stop arrived. Between its tool
 * calls it is reasoning rather than running, and says so instead of leaving the
 * last tool on screen pretending to still be busy.
 */
function subagentHtml(list) {
  if (!list || !list.length) return '';
  return '<div class="agents-list">' + list.map((a) => {
    const doing = a.tool ? a.tool + (a.arg ? ' · ' + a.arg : '') : 'reasoning';
    return `<div class="agent">
      <span class="agent-type">${esc(a.type)}</span>
      <span class="agent-doing"${a.tool ? '' : ' data-quiet="1"'}>${esc(doing)}</span>
      <span class="agent-timer" data-since="${Number(a.since) || 0}">${mmss(Date.now() - a.since)}</span>
    </div>`;
  }).join('') + '</div>';
}

function sessionHtml(s) {
  const label = stateLabel(s);
  // A stale session has reported nothing for five minutes. Whatever its
  // subagents were doing, they are not doing it now, and a live-looking list
  // with running stopwatches under a row labelled Stale is a lie the widget
  // should not tell. The count is derived from the same map, so it goes too.
  const agentLines = s.stale ? '' : subagentHtml(s.subagentList);

  // Only one blocked session can be promoted into the alert block, so any other
  // one used to sit here as a row that said "Blocked" and offered nothing. With
  // several sessions running, several can block at once; each needs its own way
  // in, or you can only ever answer whichever happened to be promoted.
  // Disabled without a pid, for the same reason the promoted button is: the shim
  // may not have posted one, and a button that cannot work must not pretend.
  const canFocus = !!(api && api.focusSession && s.pid);
  const action = s.state === 'blocked'
    ? `<button class="row-review no-drag" type="button" data-pid="${s.pid || ''}"${canFocus ? '' : ' disabled'}>
         <span>Review in terminal</span><span aria-hidden="true">&#8599;</span>
       </button>
       <div class="review-note row-note" role="status" hidden></div>`
    : '';

  return `<div class="session ${label.toLowerCase()}">
    <div class="row-top">
      <span class="project">${esc(s.projectName)}</span>
      <span class="state"><span class="state-symbol" aria-hidden="true">${symbolFor(s)}</span>${label}</span>
    </div>
    <div class="activity"><span>${esc(activityText(s))}</span></div>
    ${agentLines}
    ${metaHtml(s)}
    ${action}
  </div>`;
}

/* ---------- rendering ---------- */

function render() {
  const sessions = snapshot.sessions || [];
  const counts = snapshot.counts || { total: 0, blocked: 0, active: 0, quiet: 0 };
  const blocked = sessions.filter((s) => s.state === 'blocked');
  const alert = blocked.length > 0;

  ui.window.classList.toggle('alert', alert);
  ui.headline.hidden = alert;
  ui.alertHeading.hidden = !alert;
  ui.request.hidden = !alert;

  if (alert) {
    const b = blocked[0];
    ui.alertTitle.textContent = blocked.length === 1
      ? 'One session needs you.'
      : blocked.length + ' sessions need you.';

    ui.reqProject.textContent = b.projectName;
    ui.reqTimer.dataset.since = String(b.stateSince);
    ui.reqTimer.textContent = mmss(Date.now() - b.stateSince);

    const isShell = b.stateTool === 'Bash' || b.stateTool === 'PowerShell';
    ui.reqDesc.textContent = b.stateTool
      ? b.stateTool + (isShell ? ' command requested' : ' requested')
      : 'Permission requested';
    ui.reqCommand.textContent = b.stateArg || b.stateTool || 'Waiting for approval';
    ui.reqMeta.outerHTML = metaHtml(b).replace('class="meta"', 'class="meta" id="request-meta"');
    ui.reqMeta = el('request-meta');
    applySpendLayout(ui.request);   // data-w geometry (the CSP drops inline style attributes)

    // Focusing a terminal needs the session's pid, which only reaches us when the
    // shim posted one. Without it the button would lie, so it is disabled.
    ui.review.disabled = !(api && api.focusSession && b.pid);
    ui.review.dataset.pid = b.pid || '';
  } else if (wired === false && counts.total === 0) {
    ui.title.textContent = 'Not connected yet.';
    ui.sub.textContent = 'Sereno is not wired into Claude Code.';
  } else {
    const active = counts.active;
    ui.title.textContent = counts.total === 0 ? 'Waiting for sessions' : (active > 0 ? 'Work is moving.' : 'Ready when you are.');
    if (counts.total === 0) {
      ui.sub.textContent = 'Nothing is reporting yet.';
    } else if (active === 0) {
      ui.sub.textContent = 'No approvals waiting.';
    } else {
      const bits = [active + ' active'];
      if (counts.quiet > 0) bits.push(counts.quiet + ' quiet');
      bits.push('no approvals waiting');
      ui.sub.textContent = bits.join(' · ');
    }
  }

  // Rows: everything not already promoted into the alert block.
  const rest = alert ? sessions.filter((s) => s.id !== blocked[0].id) : sessions;
  const head = rest.slice(0, MAX_ROWS);
  const tail = rest.slice(MAX_ROWS);

  let html = head.map(sessionHtml).join('');
  if (tail.length) {
    const allQuiet = tail.every((s) => s.stale || (s.state === 'idle' && !(s.subagents > 0)));
    html += `<button class="more no-drag" type="button" aria-expanded="${expanded}">
      <span>${expanded ? 'Show fewer sessions' : '+' + tail.length + ' more session' + (tail.length > 1 ? 's' : '')}</span>
      <span>${expanded ? 'Collapse ⌃' : (allQuiet ? (tail.length === 2 ? 'Both quiet' : 'All quiet') + ' ⌄' : 'Show ⌄')}</span>
    </button>`;
    if (expanded) html += tail.map(sessionHtml).join('');
  }
  ui.rows.innerHTML = html;
  applySpendLayout(ui.rows);

  // Footer: every window the payload reports, each named and metered on its own.
  // Collapsing them to max() used to hide the one you were not about to hit,
  // which is exactly the one worth watching before starting something long.
  const windows = snapshot.windows || {};
  const keys = orderedWindows(windows);
  if (keys.length) {
    ui.footer.hidden = false;
    ui.usageWindows.innerHTML = keys.map((key) => {
      const w = windows[key];
      const label = windowLabel(key);
      const filled = Math.round(w.usedPct / 5);
      const cells = Array.from({ length: 20 },
        (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('');
      const reset = untilReset(w.resetsAt);
      return `<div class="usage-window">
        <div class="usage-line">
          <span class="usage-value">${w.usedPct}% <span>used</span></span>
          <span class="usage-label">${esc(label)}</span>
        </div>
        <div class="usage-track" role="meter" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="${w.usedPct}" aria-label="${esc(label)} consumed">${cells}</div>
        <div class="usage-reset">${esc(reset)}</div>
      </div>`;
    }).join('');
    ui.usageNote.textContent = '';
    ui.usageCost.textContent = money(snapshot.totalCost) + ' list-price est.';
  } else {
    ui.footer.hidden = snapshot.totalCost <= 0 && !(snapshot.spend && snapshot.spend.enabled === true);
    if (!ui.footer.hidden) {
      ui.usageWindows.innerHTML = '';
      ui.usageNote.textContent = snapshot.totalCost > 0 ? 'no allowance data' : '';
      ui.usageCost.textContent = snapshot.totalCost > 0 ? money(snapshot.totalCost) + ' list-price est.' : '';
    }
  }
  renderSpend();

  reportHeight();
}

/* ---------- Today block ---------- */

// Chart geometry in viewBox units; the svg scales to the footer width.
const SPEND_W = 324, SPEND_H = 30, SPEND_TOP = 12;
const SERIES_MIN_MS = 30000;

let spendSeries = null;            // last good /api/spend/series?range=24h body
let seriesFetched = { micros: null, day: null, at: 0 };
let seriesTimer = null;

const localDay = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };

/** 'on' | 'waiting' | 'unavailable' | 'off': what the footer may say about spend. */
function spendMode(sp) {
  if (!sp || sp.enabled !== true) return 'off';
  if (sp.unavailable) return 'unavailable';
  return sp.hasTelemetry === true ? 'on' : 'waiting';
}

/** Percent widths of the source bar segments (summing to 100). */
function segmentWidths(segs) {
  const sum = segs.reduce((a, b) => a + b.micros, 0);
  return segs.map((x) => (sum > 0 ? x.micros / sum * 100 : 0).toFixed(3));
}

/** The "now" marker as percentages of the chart box, so it survives any width. */
function nowPosition(x, y) {
  const H = SPEND_H + SPEND_TOP + 2;
  return { left: (x / SPEND_W * 100).toFixed(2), top: ((SPEND_TOP + y) / H * 100).toFixed(2) };
}

// The page CSP drops inline style attributes, so geometry rides in data-* and is
// applied through the CSSOM (allowed) right after the markup is inserted.
function applySpendLayout(root) {
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.getAttribute('data-w') + '%'; });
  root.querySelectorAll('[data-left]').forEach((el) => {
    el.style.left = el.getAttribute('data-left') + '%';
    el.style.top = el.getAttribute('data-top') + '%';
  });
}

function spendHtml(sp, series, now) {
  const segs = sourceSegments(sp);
  const total = Number(sp.todayMicros) > 0 ? Number(sp.todayMicros) : 0;
  const asOf = series && Number.isFinite(series.asOf) ? series.asOf : Date.now();
  const d = new Date(asOf);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const buckets = series && Array.isArray(series.buckets) ? series.buckets : [];
  const requests = buckets.filter((b) => b.since >= midnight && b.since < asOf)
    .reduce((a, b) => a + (Number(b.requests) || 0), 0);
  const chartLabel = 'Estimated spend today ' + estMoney(total) + ', ' + requests + (requests === 1 ? ' request' : ' requests');

  let chart = '';
  if (series) {
    const pts = cumulativePoints(buckets, midnight, asOf, SPEND_W, SPEND_H);
    const last = pts.split(' ').pop().split(',').map(Number);
    // x follows the clock (asOf only moves when spend does); y is today's running total.
    const nowX = nowMarkerX(Number.isFinite(now) ? now : Date.now(), midnight, SPEND_W);
    const flip = nowX > SPEND_W * 0.8;
    const np = nowPosition(nowX, last[1]);
    chart = `<div class="spend-chart" role="img" aria-label="${esc(chartLabel)}">
      <svg viewBox="0 0 ${SPEND_W} ${SPEND_H + SPEND_TOP + 2}" focusable="false" aria-hidden="true">
        <line class="spend-base" x1="0" y1="${SPEND_TOP + SPEND_H}" x2="${SPEND_W}" y2="${SPEND_TOP + SPEND_H}" vector-effect="non-scaling-stroke"/>
        <g transform="translate(0 ${SPEND_TOP})">
          <polyline class="spend-line" points="${pts}" vector-effect="non-scaling-stroke"/>
        </g>
      </svg>
      <span class="spend-dot" aria-hidden="true" data-left="${np.left}" data-top="${np.top}"></span>
      <span class="spend-now${flip ? ' flip' : ''}" data-left="${np.left}" data-top="${np.top}">Now</span>
    </div>
    <div class="spend-axis"><span>00:00</span><span>24:00</span></div>`;
  }

  const widths = segmentWidths(segs);
  const bar = segs.length
    ? `<div class="spend-bar" role="img" aria-label="${esc(barAriaLabel(segs))}">${segs.map((x, i) =>
        `<span class="seg seg-${x.key}" data-w="${widths[i]}"></span>`).join('')}</div>
      <div class="spend-legend">${segs.map((x) =>
        `<span><i class="sw seg-${x.key}" aria-hidden="true"></i>${esc(x.label)} ${x.pct}%</span>`).join('')}</div>`
    : '';

  return `<div class="spend-head"><span>Today · estimated usage</span><span class="spend-total">${esc(estMoney(total))}</span></div>${chart}${bar}`;
}

function renderSpend() {
  const mode = spendMode(snapshot.spend);
  ui.spend.hidden = mode === 'off';
  ui.consoleLine.hidden = mode === 'off';
  if (mode === 'off') { ui.spend.innerHTML = ''; return; }
  if (mode === 'unavailable') ui.spend.innerHTML = '<p class="spend-hint">Spend history unavailable</p>';
  else if (mode === 'waiting') ui.spend.innerHTML = '<p class="spend-hint">Waiting for telemetry from new Claude Code sessions</p>';
  else { ui.spend.innerHTML = spendHtml(snapshot.spend, spendSeries); applySpendLayout(ui.spend); }
}

/**
 * Refetch the 24h series only when today's total or the local day changed, and
 * at most once per 30 s (trailing: a change inside the window is picked up when
 * it closes). Never when spend is off, unavailable, or has no telemetry.
 */
function maybeFetchSeries() {
  const sp = snapshot.spend;
  if (spendMode(sp) !== 'on') return;
  const day = localDay(Date.now());
  if (spendSeries && seriesFetched.micros === sp.todayMicros && seriesFetched.day === day) return;
  const wait = seriesFetched.at + SERIES_MIN_MS - Date.now();
  if (wait > 0) {
    if (!seriesTimer) seriesTimer = setTimeout(() => { seriesTimer = null; maybeFetchSeries(); }, wait);
    return;
  }
  seriesFetched.at = Date.now();
  const want = { micros: sp.todayMicros, day };
  fetch('/api/spend/series?range=24h').then((r) => (r.ok ? r.json() : null)).then((body) => {
    if (!body || body.enabled !== true || !Array.isArray(body.buckets)) return;
    spendSeries = body;
    seriesFetched.micros = want.micros; seriesFetched.day = want.day;
    render();
  }).catch(() => {});
}

/** Ticks the timers in place, so the DOM is not rebuilt every second. */
function tick() {
  const node = ui.reqTimer;
  if (!ui.request.hidden && node && node.dataset.since) {
    node.textContent = mmss(Date.now() - Number(node.dataset.since));
  }
  // Subagents are short-lived; a stopwatch that only moved when some other
  // event happened to arrive would sit frozen for most of their life.
  //
  // But not while the collector is unreachable. These are the one thing on the
  // page asserting "this is happening right now", and the snapshot behind them
  // stopped updating - so they hold until events resume. The blocked timer above
  // is deliberately not held: a session waiting for approval really does go on
  // waiting whether or not we can still hear from it.
  if (!ui.offline.hidden) return;
  for (const el of ui.rows.querySelectorAll('.agent-timer')) {
    const since = Number(el.dataset.since);
    if (!since) continue;
    el.textContent = mmss(Date.now() - since);
  }
}

let lastHeight = 0;
function reportHeight() {
  if (!api || !api.reportHeight) return;

  // Measure what the layout WANTS, never what it was given.
  //
  // The window is created at MIN_HEIGHT and grows only by reporting a height
  // back to main, so any measurement that reads the clamped box deadlocks on
  // the very first pass: a 60px window clips everything, measures 60, asks for
  // 60, and stays there forever. That is exactly what shipped in 1.2.1.
  //
  // Summing the children avoids the loop entirely. They are flex:none, so they
  // keep their natural height even while overflowing a window too short to hold
  // them, and the row list contributes its full scrollHeight rather than the
  // box it has been squeezed into.
  let content = 0;
  for (const el of ui.window.children) {
    if (el.hidden) continue;
    if (el === ui.grip) continue;             // absolutely positioned, not in flow
    content += (el === ui.rows) ? el.scrollHeight : el.offsetHeight;
  }
  const chrome = ui.window.offsetHeight - ui.window.clientHeight;   // borders

  const h = Math.ceil(content + chrome);
  if (h && h !== lastHeight) { lastHeight = h; api.reportHeight(h); }
}

/* ---------- interaction ---------- */

document.addEventListener('click', (ev) => {
  // In the widget, main opens the console; the page never chooses the URL.
  if (ev.target.closest('#open-console') && api && api.openConsole) { ev.preventDefault(); api.openConsole(); return; }
  const more = ev.target.closest('.more');
  if (more) { expanded = !expanded; render(); return; }

  // The promoted request and every blocked row use the same button, so they use
  // the same handler; the note is whichever one belongs to the button pressed.
  const review = ev.target.closest('#review, .row-review');
  if (review && !review.disabled) {
    const pid = Number(review.dataset.pid);
    const note = review.id === 'review'
      ? ui.reviewNote
      : review.parentElement.querySelector('.row-note');
    if (api && api.focusSession && pid) {
      api.focusSession(pid).then((ok) => {
        if (ok || !note) return;
        note.hidden = false;
        note.textContent =
          'Could not find a window for that session. Approval always stays in Claude Code — switch to its terminal to answer.';
        reportHeight();
      });
    }
  }
});

// Collapsing hides the window; the tray takes over from there, and the tray is
// what brings it back. There is nothing for the page to draw in that state.
ui.collapse.addEventListener('click', () => api && api.setCollapsed && api.setCollapsed(true));

el('close').addEventListener('click', () => api && api.quit && api.quit());
el('zoom-in').addEventListener('click', () => api && api.nudgeZoom && api.nudgeZoom(+1));
el('zoom-out').addEventListener('click', () => api && api.nudgeZoom && api.nudgeZoom(-1));

// Ctrl +/-/0 and Ctrl+wheel, the shortcuts people already expect.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !api || !api.nudgeZoom) return;
  if (e.key === '=' || e.key === '+') { api.nudgeZoom(+1); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { api.nudgeZoom(-1); e.preventDefault(); }
  else if (e.key === '0') { api.setZoom(1); e.preventDefault(); }
});
window.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !api || !api.nudgeZoom) return;
  api.nudgeZoom(e.deltaY < 0 ? +1 : -1);
  e.preventDefault();
}, { passive: false });

// Width grip. Height is content-driven, so only width is dragged.
let dragging = false;
ui.grip.addEventListener('pointerdown', (e) => {
  if (!api || !api.resizeWidthBy) return;
  dragging = true;
  ui.grip.setPointerCapture(e.pointerId);
  e.preventDefault();
});
ui.grip.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (e.movementX) api.resizeWidthBy(e.movementX);
});
const endDrag = () => { dragging = false; };
ui.grip.addEventListener('pointerup', endDrag);
ui.grip.addEventListener('pointercancel', endDrag);

if (!api) {
  // Plain browser tab: nothing to quit, zoom, or resize.
  for (const id of ['close', 'zoom-in', 'zoom-out', 'collapse']) el(id).hidden = true;
  ui.grip.hidden = true;
}

/* ---------- first-run setup ---------- */

async function refreshWiring() {
  if (!api || !api.wiringStatus) { wired = null; ui.setup.hidden = true; return; }
  let st;
  try { st = await api.wiringStatus(); } catch (_) { return; }

  wired = !!st.wired;
  // Never cover live sessions: if events are arriving, it is plainly working.
  // Asking for the panel outranks that - it is the only way back to the
  // settings once sessions start reporting.
  ui.setup.hidden = !settingsOpen && (snapshot.sessions || []).length > 0;

  if (!ui.setup.hidden) {
    if (wired) {
      ui.setupBody.textContent =
        'Connected to Claude Code. Disconnecting removes Sereno’s statusline and hooks and leaves everything else in your settings untouched.';
      ui.setupActionLabel.textContent = 'Disconnect';
      ui.setupAction.dataset.mode = 'disconnect';
      ui.setupAction.dataset.replace = '';
    } else {
      ui.setupBody.textContent = setupCopy(st);
      ui.setupActionLabel.textContent = st.foreignStatusLine
        ? 'Connect and replace my statusline'
        : 'Connect to Claude Code';
      ui.setupAction.dataset.mode = 'connect';
      ui.setupAction.dataset.replace = st.foreignStatusLine ? '1' : '';
    }
  }
  render();
}

ui.setupAction.addEventListener('click', async () => {
  if (!api) return;
  const disconnecting = ui.setupAction.dataset.mode === 'disconnect';
  if (disconnecting ? !api.disconnect : !api.connect) return;

  ui.setupAction.disabled = true;
  const res = disconnecting
    ? await api.disconnect()
    : await api.connect({ replaceStatusLine: !!ui.setupAction.dataset.replace });
  ui.setupAction.disabled = false;

  ui.setupNote.hidden = false;
  if (!res || !res.ok) {
    ui.setupNote.textContent = (disconnecting ? 'Could not update settings: ' : 'Could not write settings: ')
      + ((res && res.error) || 'unknown error');
  } else if (disconnecting) {
    let msg = res.changed
      ? 'Disconnected. Restart any running Claude Code session.'
      : 'Nothing of Sereno’s was found in your settings.';
    // Entries we could not prove were ours are never deleted on suspicion, so
    // say so rather than leaving the user to wonder what was left behind.
    if (res.skipped && res.skipped.length) {
      msg += ' Left alone (not ours): ' + res.skipped.length
        + (res.skipped.length === 1 ? ' entry.' : ' entries.');
    }
    ui.setupNote.textContent = msg;
    await refreshWiring();
    await refreshSettings();
  } else {
    ui.setupNote.textContent = 'Connected. Restart any running Claude Code session to pick it up.'
      + (res.backup ? ' Backup: ' + res.backup : '');
    await refreshWiring();
    await refreshSettings();
  }
  reportHeight();
});

/* ---------- settings ---------- */

/**
 * The setup panel doubles as the settings panel: it is already the one place
 * that talks to the outside world, and a second panel would cost the widget
 * height it does not have to spare.
 */
let settingsOpen = false;

async function refreshSettings() {
  if (!api || !api.settings) { ui.autoLaunchRow.hidden = true; return; }
  // A write is in flight. The 15s re-check would otherwise read the old value
  // back off disk and flip the box under the user mid-click.
  if (ui.autoLaunch.disabled) return;
  let st;
  try { st = await api.settings(); } catch (_) { return; }
  if (!st || !st.ok) { ui.autoLaunchRow.hidden = true; return; }
  ui.autoLaunch.checked = !!st.autoLaunch;
  // Auto-launch rides on the SessionStart hook, so it can do nothing at all
  // until Sereno is connected. Offering it before then would just be a lie.
  ui.autoLaunchRow.hidden = !wired;
}

/** The /brief command row. Hidden in a browser tab: there is no main process to write the file. */
const BRIEF_STATUS = {
  'installed': ['Installed', 'Remove /brief'],
  'not-installed': ['Not installed', 'Install /brief'],
  'update-available': ['Update available', 'Update /brief'],
  'conflict': ['Conflict: a different brief.md exists', 'Install /brief'],
};

async function refreshBrief() {
  if (!api || !api.commandsStatus) { ui.briefRow.hidden = true; return; }
  if (ui.briefAction.disabled && ui.briefAction.dataset.status !== 'conflict') return;   // a click is in flight
  let st;
  try { st = await api.commandsStatus(); } catch (_) { return; }
  if (!st || !st.ok || !BRIEF_STATUS[st.status]) { ui.briefRow.hidden = true; return; }
  ui.briefRow.hidden = false;
  ui.briefStatus.textContent = BRIEF_STATUS[st.status][0];
  ui.briefAction.textContent = BRIEF_STATUS[st.status][1];
  ui.briefAction.dataset.status = st.status;
  ui.briefAction.disabled = st.status === 'conflict';
}

ui.briefAction.addEventListener('click', async () => {
  if (!api || !api.toggleBriefCommand) return;
  ui.briefAction.disabled = true;
  ui.briefAction.dataset.status = 'busy';
  let res;
  try { res = await api.toggleBriefCommand(); } catch (e) { res = { ok: false, error: e.message }; }
  ui.briefAction.disabled = false;
  ui.briefAction.dataset.status = '';
  if (!res || !res.ok) {
    ui.setupNote.hidden = false;
    ui.setupNote.textContent = 'Could not update the /brief command: ' + ((res && res.error) || 'unknown error');
  }
  await refreshBrief();
  reportHeight();
});

ui.settingsToggle.addEventListener('click', async () => {
  settingsOpen = !settingsOpen;
  ui.settingsToggle.setAttribute('aria-expanded', settingsOpen ? 'true' : 'false');
  ui.setupNote.hidden = true;
  await refreshWiring();
  await refreshSettings();
  await refreshBrief();
  reportHeight();
});

ui.autoLaunch.addEventListener('change', async () => {
  if (!api || !api.setAutoLaunch) return;
  const want = ui.autoLaunch.checked;
  ui.autoLaunch.disabled = true;
  const res = await api.setAutoLaunch(want);
  ui.autoLaunch.disabled = false;

  ui.setupNote.hidden = false;
  if (!res || !res.ok) {
    ui.autoLaunch.checked = !want;   // the box must not claim a setting that failed
    ui.setupNote.textContent = 'Could not save the setting: ' + ((res && res.error) || 'unknown error');
  } else {
    ui.setupNote.textContent = want
      ? 'Sereno will start itself the next time a Claude Code session begins.'
      : 'Sereno will only start when you open it.';
  }
  reportHeight();
});

/* ---------- transport ---------- */

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { ui.offline.hidden = true; };
  es.onmessage = (ev) => {
    try { snapshot = JSON.parse(ev.data); } catch (_) { return; }
    ui.offline.hidden = true;
    render();
    maybeFetchSeries();
  };
  es.onerror = () => { ui.offline.hidden = false; };   // EventSource retries on its own
}

connect();
render();
refreshWiring().then(refreshSettings).then(refreshBrief);
setInterval(tick, 500);
// The Now marker follows the clock: re-render the Today block (no refetch) once a minute.
setInterval(() => { if (spendMode(snapshot.spend) === 'on') renderSpend(); }, 60000);
// Cheap enough to re-check: it also catches an unwire done outside the app.
setInterval(() => { refreshWiring().then(refreshSettings).then(refreshBrief); }, 15000);
window.addEventListener('resize', reportHeight);
