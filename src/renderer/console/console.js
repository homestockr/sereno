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

/** True only when the ledger has never recorded a request (not merely none today or this month). */
function noSpendYet(today, series, projects) {
  if (today && today.hasTelemetry === true) return false;
  if (today && Number(today.requests) > 0) return false;
  const rows = projects && Array.isArray(projects.rows) ? projects.rows : [];
  if (rows.some((r) => Number(r.requests) > 0)) return false;
  const buckets = series && Array.isArray(series.buckets) ? series.buckets : [];
  return !buckets.some((b) => Number(b.requests) > 0);
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
      ...(typeof s.id === 'string' && s.id ? { sessionId: s.id } : {}),
    }));
  // Pipeline decisions (amber) and stalled repairs (informational, never amber) ride along on /state.
  const decs = (snapshot && Array.isArray(snapshot.decisions) ? snapshot.decisions : [])
    .filter((d) => d && typeof d === 'object' && typeof d.task === 'string')
    .map((d) => ({
      project: projectLabel(d.project),
      task: d.task,
      reason: typeof d.reason === 'string' ? d.reason : '',
      attempt: Number.isFinite(Number(d.attempt)) && d.attempt !== null ? Number(d.attempt) : null,
      ...(typeof d.sessionId === 'string' && d.sessionId ? { sessionId: d.sessionId } : {}),
    }));
  const stalled = (snapshot && Array.isArray(snapshot.stalled) ? snapshot.stalled : [])
    .filter((d) => d && typeof d === 'object' && typeof d.task === 'string')
    .map((d) => ({ project: projectLabel(d.project), task: d.task }));
  return {
    amber: items.length + decs.length > 0, count: items.length + decs.length, items,
    ...(decs.length ? { decisions: decs } : {}),
    ...(stalled.length ? { stalled } : {}),
  };
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
 * "Review in terminal" control for one waiting session. opts: { review, na, msgs }.
 * No control without opts.review or a session id. After a 501 (serve mode) every
 * control becomes plain text. The only thing a click ever sends is the session id.
 */
function reviewControl(it, opts) {
  if (!opts || opts.review !== true || !it || !it.sessionId) return '';
  const m = opts.msgs && opts.msgs[it.sessionId];
  if (opts.na === true || m === 'na') return '<div class="review-msg">Open the widget to review</div>';
  if (m === 'ok') return '<div class="review-msg">Raised the terminal</div>';
  return '<div class="review"><button type="button" class="btn-review" data-act="review" data-sid="' + esc(it.sessionId)
    + '">Review in terminal ↗</button>' + (m === 'err' ? '<span class="review-msg">Could not raise the terminal</span>' : '') + '</div>';
}

/**
 * Attention panel markup. Input is attentionState() output, or { unavailable: true } when
 * /state could not be read (neutral grey, never amber). Every API string goes through esc().
 * opts (optional) adds the review controls, see reviewControl().
 */
function attentionHtml(st, nowMs, opts) {
  const stalledNote = (x) => {
    const rows = x && Array.isArray(x.stalled) ? x.stalled : [];
    if (!rows.length) return '';
    return '<ul class="attn-stalled">' + rows.map((r) => '<li><strong>' + esc(r.project) + '</strong><span class="mono">' + esc(r.task)
      + '</span><span class="wait">repair looks stalled</span></li>').join('') + '</ul>';
  };
  if (!st || st.unavailable) {
    return '<div class="attn attn-off"><div class="attn-head"><span>LIVE STATUS</span></div>'
      + '<h2 class="attn-title">Live status unavailable</h2></div>';
  }
  if (!st.amber) {
    return '<div class="attn attn-calm"><div class="attn-head"><i class="dot" aria-hidden="true"></i><span>ALL CLEAR</span></div>'
      + '<p class="attn-body">Nothing needs you right now.</p>' + stalledNote(st) + '</div>';
  }
  const items = Array.isArray(st.items) ? st.items : [];
  const decs = Array.isArray(st.decisions) ? st.decisions : [];
  if (decs.length) {
    const rows = '<ul class="attn-list">' + items.map((it) => {
      const what = waitWhat(it);
      const w = waitLabel(it.since, nowMs);
      return '<li><strong>' + esc(it.project) + '</strong>' + (what ? '<span class="mono">' + what + '</span>' : '')
        + (w ? '<span class="wait">' + esc(w) + '</span>' : '') + reviewControl(it, opts) + '</li>';
    }).join('') + decs.map((d) => '<li class="attn-decision"><strong>' + esc(d.project) + '</strong><span class="mono">' + esc(d.task) + '</span>'
      + (d.reason ? '<span class="wait">' + esc(d.reason) + '</span>' : '') + reviewControl(d, opts) + '</li>').join('') + '</ul>';
    const head = items.length === 0 && decs.length === 1
      ? esc(decs[0].project) + ': review needs a decision.'
      : st.count + ' things need you.';
    return '<div class="attn attn-amber"><div class="attn-head">' + ringIcon() + '<span>NEEDS YOUR ATTENTION</span></div>'
      + '<h2 class="attn-title">' + head + '</h2>' + rows + stalledNote(st)
      + '<p class="attn-body">Answer it in the terminal. Sereno only points you there.</p></div>';
  }
  const title = items.length === 1
    ? esc(items[0].project) + ' is waiting for permission.'
    : st.count + ' sessions are waiting for permission.';
  let list = '';
  if (items.length > 1) {
    list = '<ul class="attn-list">' + items.map((it) => {
      const what = waitWhat(it);
      const w = waitLabel(it.since, nowMs);
      return '<li><strong>' + esc(it.project) + '</strong>' + (what ? '<span class="mono">' + what + '</span>' : '')
        + (w ? '<span class="wait">' + esc(w) + '</span>' : '') + reviewControl(it, opts) + '</li>';
    }).join('') + '</ul>';
  } else if (items.length === 1) {
    const what = waitWhat(items[0]);
    const w = waitLabel(items[0].since, nowMs);
    if (what) list += '<div class="attn-what mono">' + what + '</div>';
    if (w) list += '<div class="wait">' + esc(w) + '</div>';
    list += reviewControl(items[0], opts);
  }
  return '<div class="attn attn-amber"><div class="attn-head">' + ringIcon() + '<span>NEEDS YOUR ATTENTION</span></div>'
    + '<h2 class="attn-title">' + title + '</h2>' + list
    + '<p class="attn-body">Answer it in the terminal. Sereno only points you there.</p></div>';
}

/* ---------- Projects tab: pure helpers (Phase 3 step 5) ---------- */

/** '#spend' -> 'spend'; '#projects', '', and anything else -> 'projects'. */
function parseRoute(hash) {
  const h = String(hash == null ? '' : hash).replace(/^#\/?/, '').trim().toLowerCase();
  return h === 'spend' ? 'spend' : 'projects';
}

/** No hash -> the remembered tab (default projects); a hash always wins. */
function initialRoute(hash, saved) {
  const h = String(hash == null ? '' : hash).replace(/^#\/?/, '').trim();
  if (h === '') return saved === 'spend' ? 'spend' : 'projects';
  return parseRoute(hash);
}

/** '8 min ago' / '3 hours ago' / '2 days ago'; '' for a missing or non-finite time. */
function relTime(ts, nowMs) {
  const t = Number(ts);
  if (ts == null || !Number.isFinite(t) || !Number.isFinite(Number(nowMs))) return '';
  const s = Math.max(0, Math.floor((Number(nowMs) - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

/** Whole days since the brief went behind (behindSince, ms), at least 1; null when unknown. */
function staleDaysOf(behindSince, nowMs) {
  const ts = typeof behindSince === 'number' ? behindSince : NaN;
  if (!Number.isFinite(ts) || !Number.isFinite(Number(nowMs))) return null;
  return Math.max(1, Math.floor((Number(nowMs) - ts) / 86400000));
}

/** Chip text and class for a freshness state. Stale uses the dashed rule; behind is outlined. */
function freshnessChip(freshness, staleDays) {
  switch (freshness) {
    case 'fresh': return { label: 'fresh', cls: 'chip-fresh' };
    case 'behind': return { label: 'behind', cls: 'chip-behind' };
    case 'stale': {
      const n = Math.floor(Number(staleDays));
      const label = Number.isFinite(n) && n > 0 ? 'Brief is ' + n + (n === 1 ? ' day behind' : ' days behind') : 'stale';
      return { label, cls: 'chip-stale' };
    }
    case 'unknown': return { label: 'Brief source not found', cls: 'chip-unknown' };
    default: return { label: 'No brief', cls: 'chip-none' };
  }
}

/** A headline brief with a Blocked line that is neither empty nor "None". */
function hasBlocker(p) {
  const b = p && p.brief && typeof p.brief.blocked === 'string' ? p.brief.blocked.trim() : '';
  return b !== '' && !/^none\.?$/i.test(b);
}

/** Top-level live sessions of /state (tagged subagent rows never count). */
function topSessions(snapshot) {
  const list = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  return list.filter((s) => s && typeof s === 'object' && !s.agent_id && !s.agentId);
}

/** Is this session worth showing live: top-level, not stale, running / thinking / blocked. */
function isLiveSession(s) {
  return !!s && typeof s === 'object' && !s.stale && !s.agent_id && !s.agentId
    && (s.state === 'running' || s.state === 'thinking' || s.state === 'blocked');
}

/**
 * Best live session state for a project: blocked, running, thinking, idle, or null.
 * The server computes p.live (cwd under the repo or any worktree); name matching is only
 * a fallback for a payload that has no p.live.
 */
function liveState(p, sessions) {
  if (p && p.live && typeof p.live === 'object') {
    return ['blocked', 'running', 'thinking', 'idle'].includes(p.live.state) ? p.live.state : null;
  }
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && !s.stale && !s.agent_id && !s.agentId && s.projectName === p.name);
  for (const st of ['blocked', 'running', 'thinking', 'idle']) if (list.some((s) => s.state === st)) return st;
  return null;
}

const LIVE_RANK = ['idle', 'thinking', 'running', 'blocked'];

/**
 * projectId -> best live state, derived from a pushed snapshot by matching its top-level,
 * non-stale session ids against p.live.sessionIds (the server's cwd join, last /api/projects).
 * Projects without p.live are left out: they keep the server value / name fallback.
 */
function deriveLiveStates(projects, sessions) {
  const top = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s === 'object' && !s.stale && !s.agent_id && !s.agentId);
  const out = {};
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || !p.live || !Array.isArray(p.live.sessionIds)) continue;
    const ids = new Set(p.live.sessionIds);
    let rank = -1;
    for (const s of top) if (ids.has(s.id)) rank = Math.max(rank, LIVE_RANK.indexOf(s.state));
    out[p.id] = rank >= 0 ? LIVE_RANK[rank] : null;
  }
  return out;
}

/** Project ids whose derived live state differs between two derivations. */
function liveDiff(prev, next) {
  const a = prev && typeof prev === 'object' ? prev : {};
  const b = next && typeof next === 'object' ? next : {};
  const changed = [];
  for (const id of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if ((a[id] === undefined ? null : a[id]) !== (b[id] === undefined ? null : b[id])) changed.push(id);
  }
  return changed;
}

/** Projects with their live.state replaced by the derived map (sessionIds untouched). */
function withLive(projects, map) {
  return (Array.isArray(projects) ? projects : []).map((p) => (p && p.live && map && Object.prototype.hasOwnProperty.call(map, p.id)
    ? Object.assign({}, p, { live: Object.assign({}, p.live, { state: map[p.id] }) }) : p));
}

/** Snapshot session ids no project's live.sessionIds knows and `seen` has not asked about yet: a new session. */
function unknownSessionIds(projects, sessions, seen) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.some((p) => p && p.live && Array.isArray(p.live.sessionIds))) return [];
  const known = new Set();
  for (const p of list) if (p && p.live && Array.isArray(p.live.sessionIds)) for (const id of p.live.sessionIds) known.add(id);
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id && !s.stale && !s.agent_id && !s.agentId
      && !known.has(s.id) && !(seen && seen.has(s.id)))
    .map((s) => s.id);
}

/** Active = a running / thinking / blocked session for the project (idle alone does not count) or a commit in the last 24 h. */
function isActive(p, sessions, nowMs) {
  const st = liveState(p, sessions);
  if (st === 'blocked' || st === 'running' || st === 'thinking') return true;
  const c = p && p.git && p.git.lastCommitAt !== null ? Number(p.git.lastCommitAt) : NaN;
  return Number.isFinite(c) && Number(nowMs) - c < 86400000;
}

function visibleProjects(projects) {
  return (Array.isArray(projects) ? projects : []).filter((p) => p && p.hidden !== true);
}

function filterCounts(projects, sessions, nowMs) {
  const v = visibleProjects(projects);
  const active = v.filter((p) => isActive(p, sessions, nowMs)).length;
  return { all: v.length, active, quiet: v.length - active };
}

/** Visible projects for a filter ('all' | 'active' | 'quiet'), newest activity first. */
function selectProjects(projects, filter, sessions, nowMs) {
  const la = (p) => (p.lastActivity !== null && Number.isFinite(Number(p.lastActivity)) ? Number(p.lastActivity) : -1);
  return visibleProjects(projects)
    .filter((p) => (filter === 'active' ? isActive(p, sessions, nowMs) : filter === 'quiet' ? !isActive(p, sessions, nowMs) : true))
    .sort((a, b) => (la(b) - la(a)) || String(a.name).localeCompare(String(b.name)));
}

/** `N projects · N with blockers · N stale · <decision clause>` */
function projectsSummary(projects, blockedCount) {
  const v = visibleProjects(projects);
  const n = v.length;
  const blockers = v.filter(hasBlocker).length;
  const stale = v.filter((p) => p.freshness === 'stale').length;
  const b = Number(blockedCount) > 0 ? Math.floor(Number(blockedCount)) : 0;
  const clause = b === 0 ? 'nothing needs a decision' : b === 1 ? '1 session needs you' : b + ' sessions need you';
  return n + (n === 1 ? ' project' : ' projects') + ' · ' + blockers + ' with blockers · ' + stale + ' stale · ' + clause;
}

/** `main ↑2 ↓0 · 2 open PRs · Last commit 8 min ago`; absent parts are left out. */
function gitLine(git, prs, nowMs) {
  const g = git || {};
  const parts = [];
  const head = [];
  if (typeof g.defaultBranch === 'string' && g.defaultBranch) head.push(g.defaultBranch);
  if (Number.isFinite(g.ahead) && Number.isFinite(g.behind)) head.push('↑' + g.ahead + ' ↓' + g.behind);
  if (head.length) parts.push(head.join(' '));
  if (Number.isFinite(prs)) parts.push(prs + (prs === 1 ? ' open PR' : ' open PRs'));
  const rel = relTime(g.lastCommitAt, nowMs);
  if (rel) parts.push('Last commit ' + rel);
  return parts.join(' · ');
}

function sparkSvg(trend) {
  return '<svg class="spark" viewBox="0 0 110 25" aria-hidden="true"><polyline points="' + sparkPoints(trend, 110, 25) + '"></polyline></svg>';
}

/** State shape: needs-you ring (blocked), bars (running), spinner (thinking), quiet ring (idle or none). */
function liveShape(st) {
  if (st === 'blocked') return '<svg class="pshape pshape-need" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M6.2 6.3c0-1.9 3.6-1.9 3.6 0 0 1.3-1.8 1.4-1.8 2.6M8 11.1v.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  if (st === 'running') return '<svg class="pshape pshape-live" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6v4M6 3v10M9 5v6M12 4v8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  if (st === 'thinking') return '<svg class="pshape pshape-live" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 2.2"/></svg>';
  return '<svg class="pshape" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
}

/** Non-default branches: `↳ name  <chip>  <brief now or "No brief">`. */
function branchRows(branches, defaultBranch, nowMs) {
  const list = (Array.isArray(branches) ? branches : []).filter((b) => b && b.name !== defaultBranch);
  return list.map((b) => {
    const f = b && b.freshness ? b.freshness : 'none';
    const chip = freshnessChip(f, staleDaysOf(b && b.behindSince, nowMs));
    const none = f === 'none';
    return '<div class="brow"><span class="bname mono">\u21b3 ' + esc(b && b.name) + '</span>'
      + (none ? '' : '<span class="chip ' + chip.cls + '">' + esc(chip.label) + '</span>')
      + '<span class="bnow' + (b && b.now ? '' : ' quiet-text') + '">' + esc(b && b.now ? b.now : 'No brief') + '</span></div>';
  }).join('');
}

/** One project card. ctx: { now, state } (state = liveState()). Every API string goes through esc(); no style attributes. */
function cardHtml(p, ctx) {
  const c = ctx || {};
  const now = c.now;
  const chip = freshnessChip(p.freshness, staleDaysOf(p.brief ? p.brief.behindSince : null, now));
  const b = p.brief;
  const kv = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + esc(v == null || v === '' ? '—' : v) + '</span></div>';
  let body = '';
  if (b) body = kv('Now', b.now) + kv('Next', b.next) + kv('Blocked', b.blocked);
  else if (p.freshness === 'none' || p.freshness == null) body = '<div class="nobrief">No brief yet — run /brief in a session</div>';
  let git = '';
  if (p.error === true) {
    git = '<div class="git git-off">Git status unavailable</div>';
  } else {
    const line = gitLine(p.git, p.prs, now);
    const dirty = p.git && p.git.dirty === true
      ? '<span class="dirty"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4 4-4 4-4-4z" fill="currentColor"/></svg>dirty</span>' : '';
    if (line || dirty) git = '<div class="git">' + (line ? '<span>' + esc(line) + '</span>' : '') + dirty + '</div>';
  }
  const spend = p.spend14
    ? '<div class="spend14"><div class="spend-label">14-day spend</div>' + sparkSvg(p.spend14.trend)
      + '<div class="spend-num num">' + esc(estMoney(p.spend14.costMicros)) + '</div></div>' : '';
  const menu = '<details class="menu"><summary aria-label="Project actions">⋯</summary>'
    + '<button type="button" class="menu-item" data-act="hide" data-id="' + esc(p.id) + '">Hide project</button></details>';
  return '<article class="pcard">' + liveShape(c.state)
    + '<div class="pmain"><div class="phead"><h3>' + esc(p.name) + '</h3><span class="chip ' + chip.cls + '">' + esc(chip.label) + '</span></div>'
    + body + git + branchRows(p.branches, p.git ? p.git.defaultBranch : null, now) + '</div>'
    + '<div class="pside">' + menu + spend + '</div></article>';
}

/**
 * LIVE SESSIONS strip: only non-stale running / thinking / blocked sessions, newest first,
 * at most 6 and then "+N more". '' when none.
 */
function liveStrip(sessions, nowMs) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(isLiveSession)
    .sort((a, b) => (Number(b.stateSince) || 0) - (Number(a.stateSince) || 0));
  if (!list.length) return '';
  const more = list.length > 6 ? '<div class="live-more">+' + (list.length - 6) + ' more</div>' : '';
  return '<div class="live-strip"><div class="live-title">LIVE SESSIONS</div><div class="live-list">'
    + list.slice(0, 6).map((s) => {
      const rel = relTime(s.stateSince, nowMs);
      return '<div class="live-item"><strong>' + esc(s.projectName == null || s.projectName === '' ? 'Unknown project' : s.projectName)
        + ' / ' + esc(s.state) + '</strong>' + (rel ? '<span>' + esc(rel) + '</span>' : '') + '</div>';
    }).join('') + more + '</div></div>';
}

/** The hidden-projects toggle and, when open, the list with Unhide. '' when none are hidden. */
function hiddenSection(projects, open) {
  const h = (Array.isArray(projects) ? projects : []).filter((p) => p && p.hidden === true);
  if (!h.length) return '';
  const list = open ? '<ul class="hidden-list">' + h.map((p) => '<li><span>' + esc(p.name) + '</span>'
    + '<button type="button" class="link-btn" data-act="unhide" data-id="' + esc(p.id) + '">Unhide</button></li>').join('') + '</ul>' : '';
  return '<div class="hidden-box"><button type="button" class="link-btn" data-act="toggle-hidden" aria-expanded="' + (open === true) + '">'
    + h.length + ' hidden · ' + (open ? 'hide' : 'show') + '</button>' + list + '</div>';
}

/** Filter tabs with counts. */
function filterBar(counts, filter) {
  return '<div class="filters" role="group" aria-label="Filter">'
    + [['all', 'All', counts.all], ['active', 'Active', counts.active], ['quiet', 'Quiet', counts.quiet]].map((f) =>
      '<button type="button" data-filter="' + f[0] + '" class="' + (filter === f[0] ? 'on' : '') + '" aria-pressed="' + (filter === f[0]) + '">'
      + f[1] + ' ' + f[2] + '</button>').join('') + '<span class="sortnote">Last activity ↓</span></div>';
}

/** The whole Projects view body (below the title row). `sessions` is the /state session list. */
function projectsBody(projects, sessions, filter, showHidden, nowMs) {
  const all = Array.isArray(projects) ? projects : [];
  const live = topSessions({ sessions });
  // Decisions: blocked sessions the server attributed to a project (p.live); name match if no p.live.
  const owned = new Set();
  let anyLive = false;
  for (const p of all) {
    if (p && p.live && Array.isArray(p.live.sessionIds)) { anyLive = true; for (const id of p.live.sessionIds) owned.add(id); }
  }
  const blocked = live.filter((s) => s.state === 'blocked' && !s.stale && (!anyLive || owned.has(s.id))).length;
  if (!all.length) {
    return '<div class="state-panel"><h2>No projects yet</h2><p>Projects appear when a Claude Code session runs in a git repo.</p></div>';
  }
  const counts = filterCounts(all, live, nowMs);
  const shown = selectProjects(all, filter, live, nowMs);
  const cards = shown.length
    ? shown.map((p) => cardHtml(p, { now: nowMs, state: liveState(p, live) })).join('')
    : '<p class="empty-note">No projects match this filter.</p>';
  return '<p class="summary">' + esc(projectsSummary(all, blocked)) + '</p>' + filterBar(counts, filter)
    + '<div class="plist">' + cards + '</div>' + hiddenSection(all, showHidden) + liveStrip(live, nowMs);
}

/** Request for a console POST: { method, headers, body } ready for fetch(). */
function actionRequest(bodyObj, token) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sereno-token': String(token == null ? '' : token) },
    body: JSON.stringify(bodyObj),
  };
}

/** The review body carries nothing but the session id. */
function reviewRequest(sessionId, token) {
  return actionRequest({ sessionId: String(sessionId) }, token);
}

/* ---------- state ---------- */

const RANGES = ['24h', '7d', '30d'];
const SRC_LABEL = { main: 'Main', subagent: 'Subagent', auxiliary: 'Auxiliary', unattributed: 'Unattributed' };
const ATTR_LABEL = { explicit: 'Explicit', unknown: 'Unattributed', mixed: 'Mixed' };

const state = {
  range: '30d', today: null, series: null, projects: null, top: null,
  mode: 'loading', lastOk: null, token: 0,
  attn: null, attnToken: 0,   // attn: attentionState() output, { unavailable: true }, or null before the first read
  route: 'projects',
  proj: { mode: 'loading', list: [], filter: 'all', showHidden: false, token: 0, lastOk: null },
  sessions: [],               // /state sessions, for the Projects summary, filters and live strip
  liveMap: {}, liveSig: '', seenIds: new Set(),   // client-side live states from the SSE stream
  apiToken: null, reviewNA: false, reviewMsgs: {},
};

const TABS = { projects: 'Projects', spend: 'Spend' };

function loadTab() {
  try { return localStorage.getItem('sereno.console.tab'); } catch (_) { return null; }
}
function saveTab(r) {
  try { localStorage.setItem('sereno.console.tab', r); } catch (_) { /* ignore */ }
}

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
  if (box) {
    setHtml(box, attentionHtml(state.attn || { amber: false, count: 0, items: [] }, Date.now(),
      { review: true, na: state.reviewNA, msgs: state.reviewMsgs }));
  }
  const slot = document.getElementById('pill-slot');
  if (slot) setHtml(slot, pillHtml(state.attn && state.attn.amber ? state.attn.count : 0));
}

function panel(title, text) {
  return titleRow() + '<div class="state-panel"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
}

function render() {
  if (state.route !== 'spend') return;
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
  if (noSpendYet(state.today, state.series, state.projects)) {
    setHtml(view, panel('No spend recorded yet', 'Spend appears once Claude Code sessions send telemetry. Wire it from the tray: Wire telemetry…'));
    return;
  }
  setHtml(view, titleRow() + '<p class="summary">' + esc(summaryLine(state.today, state.projects)) + '</p>'
    + chartSection() + projectsSection() + promptsSection());
  applyWidths(view);
  drawChart();
}

/* ---------- Projects tab: rendering ---------- */

function projectsTitle() {
  return '<div class="title-row"><h1>Projects</h1><span id="pill-slot">' + pillHtml(state.attn && state.attn.amber ? state.attn.count : 0) + '</span></div>';
}

function renderProjects() {
  if (state.route !== 'projects') return;
  const view = document.getElementById('view');
  const p = state.proj;
  view.setAttribute('aria-busy', p.mode === 'loading' ? 'true' : 'false');
  if (p.mode === 'loading') { setHtml(view, ''); return; }
  if (p.mode === 'unavailable') {
    setHtml(view, projectsTitle() + '<div class="state-panel"><h2>Projects are unavailable right now</h2><p>Sereno will try again on the next refresh.</p></div>');
    return;
  }
  setHtml(view, projectsTitle() + projectsBody(withLive(p.list, state.liveMap), state.sessions, p.filter, p.showHidden, Date.now()));
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

/* ---------- live stream: /events pushes a full snapshot (same shape as /state) ---------- */

let stream = null;
function streamOpen() { return !!stream && stream.readyState === 1; }

/** Apply one snapshot: attention panel every time, cards only when a project's live state changed. */
function applySnapshot(snap) {
  state.attnToken++;   // an in-flight /state fetch is now older than this push
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  state.attn = attentionState(snap);
  state.sessions = sessions;
  renderAttention();
  const map = deriveLiveStates(state.proj.list, sessions);
  const strip = sessions.filter(isLiveSession).map((s) => s.id + ':' + s.state).sort().join(',');
  const sig = strip + '|' + state.attn.count;
  const changed = liveDiff(state.liveMap, map).length > 0 || sig !== state.liveSig;
  state.liveMap = map; state.liveSig = sig;
  if (state.route === 'projects' && changed) renderProjects();
  if (state.proj.mode === 'data') {
    const fresh = unknownSessionIds(state.proj.list, sessions, state.seenIds);
    if (fresh.length) { fresh.forEach((id) => state.seenIds.add(id)); refreshProjects(); }
  }
}

function openStream() {
  if (stream || typeof EventSource === 'undefined') return;
  stream = new EventSource('/events');
  stream.onmessage = (e) => {
    let snap = null;
    try { snap = JSON.parse(e.data); } catch (_) { return; }
    if (snap && Array.isArray(snap.sessions)) applySnapshot(snap);
  };
}

async function refreshAttention() {
  if (streamOpen() && state.attn && !state.attn.unavailable) return;   // the stream is the source while it is open
  const token = ++state.attnToken;
  const r = await getJson('/state');
  if (token !== state.attnToken) return;
  state.attn = r.body && Array.isArray(r.body.sessions) ? attentionState(r.body) : { unavailable: true };
  state.sessions = r.body && Array.isArray(r.body.sessions) ? r.body.sessions : [];
  state.liveMap = deriveLiveStates(state.proj.list, state.sessions);
  renderAttention();
  if (state.route === 'projects') renderProjects();
}

async function refreshProjects() {
  const p = state.proj;
  const token = ++p.token;
  const r = await getJson('/api/projects');
  if (token !== p.token) return;
  if (!r.body || !Array.isArray(r.body.projects)) {
    if (p.mode !== 'data') p.mode = 'unavailable';   // keep showing the last good list on a blip
  } else {
    p.list = r.body.projects; p.mode = 'data'; p.lastOk = Date.now();
    // server cwd join + the current snapshot; before any snapshot, the server's p.live stands
    state.liveMap = state.attn && !state.attn.unavailable ? deriveLiveStates(p.list, state.sessions) : {};
  }
  renderProjects();
  tickSync();
}

/* Console POSTs: the token comes from GET /api/token, cached, refetched once on a 403. */
async function getApiToken(force) {
  if (state.apiToken && !force) return state.apiToken;
  const r = await getJson('/api/token');
  state.apiToken = r.body && typeof r.body.token === 'string' ? r.body.token : null;
  return state.apiToken;
}

async function postAction(url, bodyObj) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getApiToken(attempt > 0);
    if (!tok) return 0;
    const req = actionRequest(bodyObj, tok);
    let status = 0;
    try { status = (await fetch(url, { method: req.method, headers: req.headers, body: req.body, cache: 'no-store' })).status; } catch (_) { return 0; }
    if (status !== 403) return status;
  }
  return 403;
}

async function reviewSession(sid) {
  const status = await postAction('/api/review', { sessionId: String(sid) });
  if (status === 204) state.reviewMsgs[sid] = 'ok';
  else if (status === 501) { state.reviewMsgs[sid] = 'na'; state.reviewNA = true; }
  else state.reviewMsgs[sid] = 'err';
  renderAttention();
}

async function setHidden(id, hidden) {
  const status = await postAction('/api/projects/' + encodeURIComponent(id) + '/hide', { hidden });
  if (status === 204) refreshProjects();
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

/** Refresh whatever the current tab shows. */
function refreshActive() {
  if (state.route === 'spend') refresh();
  else { refreshAttention(); refreshProjects(); }
}

function applyRoute(route, first) {
  state.route = route;
  document.querySelectorAll('.nav-item').forEach((a) => {
    const on = a.getAttribute('data-route') === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const crumb = document.getElementById('crumb-tab');
  if (crumb) crumb.textContent = TABS[route];
  const foot = document.getElementById('foot-note');
  if (foot) foot.textContent = route === 'spend'
    ? 'Totals include unattributed usage \u00b7 every figure is an estimate'
    : 'Dollar figures are estimates \u00b7 nothing leaves this machine';
  if (!first) saveTab(route);
  const side = document.getElementById('side-today');
  if (side) setHtml(side, '');
  if (route === 'spend') { render(); refresh(); }
  else { renderProjects(); refreshActive(); }
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
  if (el) el.textContent = syncLabel(state.route === 'spend' ? state.lastOk : state.proj.lastOk, Date.now());
}

/* ---------- boot ---------- */

function boot() {
  loadRange();
  const host = document.getElementById('foot-host');
  if (host) host.textContent = location.host + '/console';
  document.getElementById('view').addEventListener('click', (e) => {
    const tgt = e.target && e.target.closest ? e.target : null;
    const act = tgt ? tgt.closest('button[data-act], button[data-filter]') : null;
    if (act) {
      const f = act.getAttribute('data-filter');
      const a = act.getAttribute('data-act');
      if (f) { state.proj.filter = f; renderProjects(); return; }
      if (a === 'toggle-hidden') { state.proj.showHidden = !state.proj.showHidden; renderProjects(); return; }
      if (a === 'hide' || a === 'unhide') { setHidden(act.getAttribute('data-id'), a === 'hide'); return; }
    }
    const b = tgt ? tgt.closest('button[data-range]') : null;
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
  document.getElementById('attn').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-act="review"]') : null;
    if (b) reviewSession(b.getAttribute('data-sid'));
  });
  window.addEventListener('hashchange', () => {
    const r = parseRoute(location.hash);
    if (r !== state.route) applyRoute(r, false);
  });
  window.addEventListener('focus', () => { if (state.route === 'projects') refreshProjects(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshActive(); });
  setInterval(() => { if (document.visibilityState === 'visible' && state.route === 'spend') refresh(); }, 60000);
  setInterval(() => { if (document.visibilityState === 'visible' && state.route === 'projects') refreshProjects(); }, 30000);
  // The /events stream drives the attention panel; poll /state only while it is not open.
  setInterval(() => {
    if (stream && stream.readyState === 2) { stream = null; openStream(); }   // the server refused or dropped it: try again
    if (document.visibilityState === 'visible' && !streamOpen()) refreshAttention();
  }, 10000);
  window.addEventListener('pagehide', () => { if (stream) { stream.close(); stream = null; } });
  window.addEventListener('pageshow', (e) => { if (e.persisted) openStream(); });
  openStream();
  setInterval(tickSync, 10000);
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawChart(); });
  });
  applyRoute(initialRoute(location.hash, loadTab()), true);   // also reads /state; the panel stays empty until it answers
}

if (typeof document !== 'undefined') boot();
