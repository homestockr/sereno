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
  usagePct: el('usage-pct'), usageLabel: el('usage-label'), usageTrack: el('usage-track'),
  usageReset: el('usage-reset'), usageCost: el('usage-cost'),
  offline: el('offline'), grip: el('size-grip'),
  setup: el('setup'), setupBody: el('setup-body'), setupAction: el('setup-action'),
  setupActionLabel: el('setup-action-label'), setupNote: el('setup-note'),
  settingsToggle: el('settings-toggle'),
  autoLaunchRow: el('autolaunch-row'), autoLaunch: el('autolaunch'),
};

// null until the first status check; only false means "definitely not wired".
let wired = null;

let snapshot = { sessions: [], totalCost: 0, windows: {}, counts: { total: 0, blocked: 0, active: 0, quiet: 0 } };
let expanded = false;

/* ---------- formatting ---------- */

const money = (v) => '$' + Number(v || 0).toFixed(2);

function mmss(ms) {
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
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return 'Resets in ' + (h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm');
}

/** Stale is a presentation state: it overrides whatever the session was doing. */
function stateLabel(s) {
  if (s.stale) return 'Stale';
  return s.state.charAt(0).toUpperCase() + s.state.slice(1);
}

function activityText(s) {
  if (s.stale) return 'No activity for ' + humanMinutes(s.staleForMs);
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
    ? `<span class="context"><span class="context-track" aria-hidden="true"><i style="width:${s.contextPct}%"></i></span>Context ${s.contextPct}%</span>`
    : '<span class="context">Context —</span>';
  const cost = typeof s.costUsd === 'number' ? money(s.costUsd) + ' est.' : '';
  return `<div class="meta">${ctx}<span>${cost}</span></div>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sessionHtml(s) {
  const label = stateLabel(s);
  const agents = s.subagents > 0
    ? `<span class="agents">+${s.subagents} subagent${s.subagents > 1 ? 's' : ''}</span>`
    : '';
  return `<div class="session ${label.toLowerCase()}">
    <div class="row-top">
      <span class="project">${esc(s.projectName)}</span>
      <span class="state"><span class="state-symbol" aria-hidden="true">${symbolFor(s)}</span>${label}</span>
    </div>
    <div class="activity"><span>${esc(activityText(s))}</span>${agents}</div>
    ${metaHtml(s)}
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
    const allQuiet = tail.every((s) => s.stale || s.state === 'idle');
    html += `<button class="more no-drag" type="button" aria-expanded="${expanded}">
      <span>${expanded ? 'Show fewer sessions' : '+' + tail.length + ' more session' + (tail.length > 1 ? 's' : '')}</span>
      <span>${expanded ? 'Collapse ⌃' : (allQuiet ? (tail.length === 2 ? 'Both quiet' : 'All quiet') + ' ⌄' : 'Show ⌄')}</span>
    </button>`;
    if (expanded) html += tail.map(sessionHtml).join('');
  }
  ui.rows.innerHTML = html;

  // Footer: name the window that is actually binding rather than assuming 5-hour.
  const windows = snapshot.windows || {};
  const keys = Object.keys(windows);
  if (keys.length) {
    const key = keys.reduce((a, b) => (windows[b].usedPct > windows[a].usedPct ? b : a));
    const w = windows[key];
    const label = key === 'five_hour' ? '5-hour allowance'
      : key === 'seven_day' ? '7-day allowance'
      : key.replace(/_/g, ' ') + ' allowance';

    ui.footer.hidden = false;
    ui.usagePct.textContent = w.usedPct;
    ui.usageLabel.textContent = label;
    ui.usageTrack.setAttribute('aria-valuenow', String(w.usedPct));
    ui.usageTrack.setAttribute('aria-label', label + ' consumed');
    const filled = Math.round(w.usedPct / 5);
    ui.usageTrack.innerHTML = Array.from({ length: 20 },
      (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('');
    ui.usageReset.textContent = untilReset(w.resetsAt);
    ui.usageCost.textContent = money(snapshot.totalCost) + ' list-price est.';
  } else {
    ui.footer.hidden = snapshot.totalCost <= 0;
    if (!ui.footer.hidden) {
      ui.usagePct.textContent = '—';
      ui.usageLabel.textContent = 'no allowance data';
      ui.usageTrack.innerHTML = '';
      ui.usageReset.textContent = '';
      ui.usageCost.textContent = money(snapshot.totalCost) + ' list-price est.';
    }
  }

  reportHeight();
}

/** Ticks only the waiting timer, so the DOM is not rebuilt every second. */
function tick() {
  const node = ui.reqTimer;
  if (!ui.request.hidden && node && node.dataset.since) {
    node.textContent = mmss(Date.now() - Number(node.dataset.since));
  }
}

let lastHeight = 0;
function reportHeight() {
  if (!api || !api.reportHeight) return;
  const h = Math.ceil(ui.window.getBoundingClientRect().height);
  if (h && h !== lastHeight) { lastHeight = h; api.reportHeight(h); }
}

/* ---------- interaction ---------- */

document.addEventListener('click', (ev) => {
  const more = ev.target.closest('.more');
  if (more) { expanded = !expanded; render(); return; }

  const review = ev.target.closest('#review');
  if (review && !review.disabled) {
    const pid = Number(review.dataset.pid);
    if (api && api.focusSession && pid) {
      api.focusSession(pid).then((ok) => {
        if (ok) return;
        ui.reviewNote.hidden = false;
        ui.reviewNote.textContent =
          'Could not find a window for that session. Approval always stays in Claude Code — switch to its terminal to answer.';
        reportHeight();
      });
    }
  }
});

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
  for (const id of ['close', 'zoom-in', 'zoom-out']) el(id).hidden = true;
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
      ui.setupBody.textContent = st.foreignStatusLine
        ? 'Sereno adds a statusline and nine hooks to Claude Code’s settings. You already have a statusline configured — connecting replaces it. Your settings file is backed up first.'
        : 'Sereno adds a statusline and nine hooks to Claude Code’s settings. Existing entries are kept, and your settings file is backed up first.';
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

ui.settingsToggle.addEventListener('click', async () => {
  settingsOpen = !settingsOpen;
  ui.settingsToggle.setAttribute('aria-expanded', settingsOpen ? 'true' : 'false');
  ui.setupNote.hidden = true;
  await refreshWiring();
  await refreshSettings();
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
  };
  es.onerror = () => { ui.offline.hidden = false; };   // EventSource retries on its own
}

connect();
render();
refreshWiring().then(refreshSettings);
setInterval(tick, 500);
// Cheap enough to re-check: it also catches an unwire done outside the app.
setInterval(() => { refreshWiring().then(refreshSettings); }, 15000);
window.addEventListener('resize', reportHeight);
