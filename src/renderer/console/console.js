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
    .map((d) => ({ project: projectLabel(d.project), task: d.task, kind: d.kind === 'repair' ? 'repair' : 'build' }));
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
      + '</span><span class="wait">' + (r.kind === 'repair' ? 'Repair stalled' : 'Build stalled') + '</span></li>').join('') + '</ul>';
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

/** '#spend', '#spend/projects', '#spend/turns?p=x' -> 'spend'; '#projects', '', and anything else -> 'projects'. */
function parseRoute(hash) {
  const h = String(hash == null ? '' : hash).replace(/^#\/?/, '').trim().toLowerCase();
  if (/^spend(\/(projects|turns|cache))?(\?p=[^&#?]{1,1800})?$/.test(h)) return 'spend';
  return h === 'pipeline' || /^pipeline\/(work|signals|routing)$/.test(h) ? 'pipeline' : 'projects';
}

/** '#pipeline/signals' -> 'signals', '#pipeline/routing' -> 'routing'; anything else -> 'work'. */
function parsePipeSub(hash) {
  const m = /^pipeline\/(work|signals|routing)$/.exec(String(hash == null ? '' : hash).replace(/^#\/?/, '').trim().toLowerCase());
  return m ? m[1] : 'work';
}

/** No hash -> the remembered tab (default projects); a hash always wins. */
function initialRoute(hash, saved) {
  const h = String(hash == null ? '' : hash).replace(/^#\/?/, '').trim();
  if (h === '') return saved === 'spend' || saved === 'pipeline' ? saved : 'projects';
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

function visibleProjects(projects) {
  return (Array.isArray(projects) ? projects : []).filter((p) => p && p.hidden !== true);
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

/* ---------- Projects navigator (alpha.6 N2). Observe only: the one action is Review in terminal, with a live session. ---------- */

const NAV_FILTERS = [['all', 'All'], ['active', 'Active'], ['blockers', 'With blockers']];
const NAV_SORTS = [['pinned', 'Pinned first'], ['recent', 'Recent'], ['name', 'Name']];
const NAV_TABS = [['branches', 'Branches'], ['activity', 'Activity'], ['git', 'Git & PRs']];
const NAV_LIVE_TEXT = { blocked: 'Needs you', running: 'Running', thinking: 'Thinking', idle: 'Idle' };
const NAV_ACTIVITY_MAX = 20;

/** '#projects/<id>' -> id (only [A-Za-z0-9_-], up to 64 chars, the collector's id alphabet); anything else -> null. */
function parseProjectSel(hash) {
  const m = /^projects\/([A-Za-z0-9_-]{1,64})$/.exec(String(hash == null ? '' : hash).replace(/^#\/?/, '').trim());
  return m ? m[1] : null;
}

/** Counts behind the filter chips (visible projects only), from the API's active / blockers flags. */
function navCounts(projects) {
  const v = visibleProjects(projects);
  return { all: v.length, active: v.filter((p) => p.active === true).length, blockers: v.filter((p) => p.blockers === true).length };
}

/** Visible projects for a chip: 'all' | 'active' | 'blockers' (anything else counts as all). */
function navFilter(projects, filter) {
  return visibleProjects(projects).filter((p) => (filter === 'active' ? p.active === true : filter === 'blockers' ? p.blockers === true : true));
}

/** Client-side search over the project name. */
function navSearch(list, q) {
  const s = String(q == null ? '' : q).trim().toLowerCase();
  const arr = Array.isArray(list) ? list : [];
  return s ? arr.filter((p) => String(p.name).toLowerCase().indexOf(s) >= 0) : arr;
}

/** 'name' sorts by name; anything else by newest activity, then name. */
function navSort(list, sort) {
  const la = (p) => (typeof p.lastActivityAt === 'number' && Number.isFinite(p.lastActivityAt) ? p.lastActivityAt : -1);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const arr = (Array.isArray(list) ? list : []).slice();
  return sort === 'name' ? arr.sort(byName) : arr.sort((a, b) => (la(b) - la(a)) || byName(a, b));
}

/** Pinned (only under "Pinned first"), Projects (active) and Inactive. */
function navGroups(list, sort) {
  const s = navSort(list, sort);
  const pinned = sort === 'pinned' ? s.filter((p) => p.pinned === true) : [];
  const rest = s.filter((p) => pinned.indexOf(p) < 0);
  return { pinned, projects: rest.filter((p) => p.active === true), inactive: rest.filter((p) => p.active !== true) };
}

/** The selected project id: the route's id if it is a visible project, else the first pinned, else the first active, else the first. */
function navResolveSel(projects, sel) {
  const v = navSort(visibleProjects(projects), 'recent');
  const hit = v.find((p) => p.id === sel);
  if (hit) return hit.id;
  const pick = v.find((p) => p.pinned === true) || v.find((p) => p.active === true) || v[0];
  return pick ? pick.id : null;
}

/** Arrow / Home / End movement over the ids of the rows on screen; clamped; null with no rows. */
function navMove(ids, sel, key) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return null;
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  const i = list.indexOf(sel);
  if (i < 0) return list[0];
  return list[Math.max(0, Math.min(list.length - 1, i + (key === 'ArrowUp' ? -1 : 1)))];
}

/** Non-default branches of a project. */
function navBranches(p) {
  const def = p && p.git ? p.git.defaultBranch : null;
  return (p && Array.isArray(p.branches) ? p.branches : []).filter((b) => b && b.name !== def);
}

/** `Running · 3 branches`, `Idle`, or the brief freshness (`fresh`, `No brief`, `Brief is 9 days behind`). */
function navStatus(p, nowMs) {
  const st = liveState(p, []);
  const head = st ? NAV_LIVE_TEXT[st] : freshnessChip(p.freshness, staleDaysOf(p.brief ? p.brief.behindSince : null, nowMs)).label;
  const nb = navBranches(p).length;
  return head + (nb > 0 ? ' · ' + nb + (nb === 1 ? ' branch' : ' branches') : '');
}

/** `N projects · N with blockers · N stale · N decisions`, from the API's counts (derived from the list when absent). */
function navSummary(counts, projects) {
  const v = visibleProjects(projects);
  const ok = counts && typeof counts === 'object';
  const num = (x, fb) => (ok && Number.isFinite(counts[x]) && counts[x] >= 0 ? Math.floor(counts[x]) : fb);
  const n = num('total', v.length);
  const blockers = num('withBlockers', v.filter((p) => p.blockers === true).length);
  const stale = num('stale', v.filter((p) => p.freshness === 'stale').length);
  const dec = num('decisions', 0);
  return n + (n === 1 ? ' project' : ' projects') + ' · ' + blockers + ' with blockers · ' + stale + ' stale · ' + dec + (dec === 1 ? ' decision' : ' decisions');
}

function pinIcon(on) {
  return '<svg class="pin-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2.5h5l-.7 4 2 2.2v1H8.6V14H7.4v-4.3H4.2v-1l2-2.2z" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}

/** One list row (grid pattern: row + cells). o: { sel, focus, nowMs }. The pin button is the row's only control. */
function navRowHtml(p, o) {
  const st = liveState(p, []);
  const pinned = p.pinned === true;
  return '<div class="nrow' + (o.sel ? ' sel' : '') + '" role="row" tabindex="' + (o.focus ? '0' : '-1') + '" data-nsel="' + esc(p.id) + '" aria-selected="' + (o.sel === true) + '">'
    + '<div class="ncell-main" role="gridcell">' + liveShape(st) + '<span class="nwrap"><span class="nname">' + esc(p.name) + '</span>'
    + '<span class="nstatus">' + esc(navStatus(p, o.nowMs)) + '</span></span>' + (st ? '<span class="nlive">live</span>' : '') + '</div>'
    + '<div class="ncell-pin" role="gridcell"><button type="button" class="pinbtn' + (pinned ? ' on' : '') + '" data-act="pin" data-id="' + esc(p.id) + '" data-pinned="' + pinned
    + '" aria-pressed="' + pinned + '" aria-label="' + esc((pinned ? 'Unpin ' : 'Pin ') + p.name) + '">' + pinIcon(pinned) + '</button></div></div>';
}

/** Project ids in on-screen order (Inactive only while open or while searching). o: { filter, q, sort, open }. */
function navVisibleIds(projects, o) {
  const g = navGroups(navSearch(navFilter(projects, o.filter), o.q), o.sort);
  const ids = g.pinned.concat(g.projects);
  return (o.open && o.open.inactive) || String(o.q || '').trim() ? ids.concat(g.inactive).map((p) => p.id) : ids.map((p) => p.id);
}

/** The scrolling list: Pinned, Projects, then a collapsed Inactive (N). o: { filter, q, sort, open, sel, nowMs }. */
function navListHtml(projects, o) {
  const g = navGroups(navSearch(navFilter(projects, o.filter), o.q), o.sort);
  if (!g.pinned.length && !g.projects.length && !g.inactive.length) return '<p class="empty-note">No projects match.</p>';
  const searching = String(o.q || '').trim() !== '';
  const openInactive = (o.open && o.open.inactive === true) || searching;
  const ids = navVisibleIds(projects, o);
  const focusId = ids.indexOf(o.sel) >= 0 ? o.sel : ids[0];
  const rows = (arr, label) => '<div class="nrows" role="grid" aria-label="' + esc(label) + '">'
    + arr.map((p) => navRowHtml(p, { sel: p.id === o.sel, focus: p.id === focusId, nowMs: o.nowMs })).join('') + '</div>';
  let h = '';
  if (g.pinned.length) h += '<section class="ngroup"><h3 class="ngroup-title">Pinned <span>' + g.pinned.length + '</span></h3>' + rows(g.pinned, 'Pinned projects') + '</section>';
  if (g.projects.length) h += '<section class="ngroup"><h3 class="ngroup-title">Projects <span>' + g.projects.length + '</span></h3>' + rows(g.projects, 'Projects') + '</section>';
  if (g.inactive.length) {
    h += '<details class="ngroup ninactive"' + (openInactive ? ' open' : '') + '><summary>Inactive (' + g.inactive.length + ')</summary>' + rows(g.inactive, 'Inactive projects') + '</details>';
  }
  return h;
}

/** Filter chips with counts, the search box and the sort menu. */
function navControlsHtml(counts, o) {
  return '<div class="nchips" role="group" aria-label="Filter">' + NAV_FILTERS.map((f) => {
    const c = f[0] === 'all' ? counts.all : f[0] === 'active' ? counts.active : counts.blockers;
    return '<button type="button" class="nchip' + (o.filter === f[0] ? ' on' : '') + '" data-filter="' + f[0] + '" aria-pressed="' + (o.filter === f[0]) + '">' + f[1] + ' <span class="num">' + c + '</span></button>';
  }).join('') + '</div>'
    + '<div class="ntools"><input type="search" class="nsearch" data-nq aria-label="Search projects" placeholder="Search projects" value="' + esc(o.q || '') + '" autocomplete="off">'
    + '<label class="nsort">Sort <select data-nsort aria-label="Sort projects">' + NAV_SORTS.map((s) => '<option value="' + s[0] + '"' + (o.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>').join('') + '</select></label></div>';
}

/** One command with its copy button (the Pipeline install panel and the brief card share it). */
function cmdRow(c) {
  return '<div class="cmd"><code>' + esc(c) + '</code><button type="button" class="btn-copy" data-act="copy" data-text="' + esc(c) + '">Copy</button></div>';
}

/** The brief card: Now / Next / Blocked with freshness, or "No brief yet" with the copy button (and install commands when the plugin is missing). */
function navBriefHtml(p, c) {
  const chip = freshnessChip(p.freshness, staleDaysOf(p.brief ? p.brief.behindSince : null, c.nowMs));
  const b = p.brief;
  const kv = (k, v, cls) => '<div class="kv"><span class="k">' + k + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + esc(v == null || v === '' ? '—' : v) + '</span></div>';
  const gen = b && typeof b.generatedAt === 'number' ? relTime(b.generatedAt, c.nowMs) : (b && typeof b.generatedAt === 'string' ? relTime(Date.parse(b.generatedAt), c.nowMs) : '');
  let body;
  if (b) {
    body = kv('Now', b.now) + kv('Next', b.next) + kv('Blocked', b.blocked, hasBlocker(p) ? 'blocked-line' : '');
  } else {
    body = '<p class="nobrief">No brief yet</p>' + cmdRow('/sereno:brief')
      + (c.pluginMissing === true ? '<p class="nobrief">The Sereno plugin is not detected. Install it in Claude Code first:</p>' + INSTALL_CMDS.map(cmdRow).join('') : '');
  }
  return '<section class="ncard" aria-label="Brief"><div class="ncard-head"><h3>Brief</h3><span class="chip ' + chip.cls + '">' + esc(chip.label) + '</span>'
    + (gen ? '<span class="quiet-text">Updated ' + esc(gen) + '</span>' : '') + '</div>' + body + '</section>';
}

/** 14-day spend: sparkline and total, an estimate. */
function navSpendHtml(p) {
  if (!p.spend14) return '<section class="ncard nspend" aria-label="Spend"><div class="ncard-head"><h3>14-day spend</h3></div><p class="nobrief">No spend recorded</p></section>';
  return '<section class="ncard nspend" aria-label="Spend"><div class="ncard-head"><h3>14-day spend</h3></div>'
    + '<div class="nspend-row">' + sparkSvg(p.spend14.trend) + '<span class="num nspend-total">' + esc(estMoney(p.spend14.costMicros)) + '</span></div></section>';
}

/** Branch list: name, ahead/behind, brief freshness, last commit. Only the default branch has git numbers; the rest show a dash. */
function navBranchesHtml(p, nowMs) {
  const g = p.git || {};
  const dash = '<span class="quiet-text">—</span>';
  const rows = [];
  const byName = new Map((Array.isArray(p.branches) ? p.branches : []).filter((b) => b).map((b) => [b.name, b]));
  if (typeof g.defaultBranch === 'string' && g.defaultBranch) {
    const db = byName.get(g.defaultBranch);
    const ab = Number.isFinite(g.ahead) && Number.isFinite(g.behind) ? '↑' + g.ahead + ' ↓' + g.behind : '';
    rows.push({ name: g.defaultBranch, def: true, ab, f: db ? db.freshness : p.freshness, bs: db ? db.behindSince : null, last: relTime(g.lastCommitAt, nowMs) });
  }
  for (const b of navBranches(p)) rows.push({ name: b.name, def: false, ab: '', f: b.freshness, bs: b.behindSince, last: '' });
  if (!rows.length) return '<p class="empty-note">No branches yet.</p>';
  return '<div class="nbranches" role="table" aria-label="Branches"><div class="nbr nbr-head" role="row"><span role="columnheader">Branch</span><span role="columnheader">Ahead / behind</span>'
    + '<span role="columnheader">Brief</span><span role="columnheader">Last commit</span></div>'
    + rows.map((r) => {
      const chip = freshnessChip(r.f || 'none', staleDaysOf(r.bs, nowMs));
      return '<div class="nbr" role="row"><span class="mono nbname" role="cell">' + esc(r.name) + (r.def ? ' <span class="quiet-text">default</span>' : '') + '</span>'
        + '<span class="num" role="cell">' + (r.ab ? esc(r.ab) : dash) + '</span><span role="cell"><span class="chip ' + chip.cls + '">' + esc(chip.label) + '</span></span>'
        + '<span role="cell">' + (r.last ? esc(r.last) : dash) + '</span></div>';
    }).join('') + '</div>';
}

/** One activity line from { at, kind, text?, outcome? }; the commit subject is the only free text. '' for an unknown kind. */
function navActivityText(e) {
  if (!e || typeof e !== 'object') return '';
  if (e.kind === 'commit') return typeof e.subject === 'string' && e.subject ? e.subject : 'Commit';   // the commit subject is the one free-text field
  if (e.kind === 'brief') return 'Brief updated';
  if (e.kind === 'pipeline') {
    const oc = e.outcome ? (OUTCOME_LABEL[e.outcome] || String(e.outcome)) : '';
    return oc ? 'Pipeline: ' + oc : 'Pipeline activity';
  }
  return '';
}

/** Newest first, at most 20. */
function navActivityHtml(p, nowMs) {
  const rows = (Array.isArray(p.activity) ? p.activity : []).filter((e) => e && Number.isFinite(Number(e.at)) && navActivityText(e))
    .sort((a, b) => Number(b.at) - Number(a.at)).slice(0, NAV_ACTIVITY_MAX);
  if (!rows.length) return '<p class="empty-note">No recent activity.</p>';
  return '<ul class="nact">' + rows.map((e) => '<li><span class="nact-kind quiet-text">' + esc(e.kind) + '</span><span class="nact-text">' + esc(navActivityText(e))
    + '</span><span class="quiet-text">' + esc(relTime(e.at, nowMs)) + '</span></li>').join('') + '</ul>';
}

/** Git & PRs: the default branch state and the open PR count, which is all we hold. */
function navGitHtml(p, nowMs) {
  if (p.error === true) return '<p class="empty-note">Git status unavailable.</p>';
  const g = p.git || {};
  const row = (k, v) => '<dt>' + k + '</dt><dd>' + esc(v == null || v === '' ? '—' : v) + '</dd>';
  const ab = Number.isFinite(g.ahead) && Number.isFinite(g.behind) ? '↑' + g.ahead + ' ↓' + g.behind : '';
  return '<dl class="pkv ngit">' + row('Default branch', g.defaultBranch) + row('Ahead / behind', ab)
    + row('Open PRs', Number.isFinite(p.prs) ? String(p.prs) : '') + row('Working tree', g.dirty === true ? 'Uncommitted changes' : g.dirty === false ? 'Clean' : '')
    + row('Last commit', relTime(g.lastCommitAt, nowMs)) + '</dl>';
}

/** Footer strip while a session is live: state and time of the project's newest live session. '' when none. */
function navLiveStrip(p, sessions, nowMs) {
  const st = liveState(p, []);
  if (!st) return '';
  const ids = new Set(p.live && Array.isArray(p.live.sessionIds) ? p.live.sessionIds : []);
  const mine = topSessions({ sessions }).filter((s) => !s.stale && ids.has(s.id)).sort((a, b) => (Number(b.stateSince) || 0) - (Number(a.stateSince) || 0));
  const lead = mine[0];
  const state = lead && NAV_LIVE_TEXT[lead.state] ? lead.state : st;
  const rel = lead ? relTime(lead.stateSince, nowMs) : '';
  const more = mine.length > 1 ? ' · ' + mine.length + ' sessions' : '';
  return '<div class="nlivebar" aria-label="Live session">' + liveShape(state) + '<strong>' + esc(NAV_LIVE_TEXT[state]) + '</strong>'
    + (rel ? '<span class="quiet-text">' + esc(rel) + '</span>' : '') + '<span class="quiet-text">' + esc(more) + '</span></div>';
}

/** The detail pane for one project. c: { nowMs, sid, opts, tab, pluginMissing, sessions }. */
function navDetailHtml(p, c) {
  if (!p) return '<div class="ndetail-empty"><p class="empty-note">Select a project.</p></div>';
  const chip = freshnessChip(p.freshness, staleDaysOf(p.brief ? p.brief.behindSince : null, c.nowMs));
  const blocked = liveState(p, []) === 'blocked';
  let git = '';
  if (p.error === true) git = '<div class="git git-off">Git status unavailable</div>';
  else {
    const line = gitLine(p.git, p.prs, c.nowMs);
    const dirty = p.git && p.git.dirty === true
      ? '<span class="dirty"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4 4-4 4-4-4z" fill="currentColor"/></svg>dirty</span>' : '';
    if (line || dirty) git = '<div class="git">' + (line ? '<span>' + esc(line) + '</span>' : '') + dirty + '</div>';
  }
  const review = c.sid ? reviewControl({ sessionId: c.sid }, c.opts) : '';
  const tab = NAV_TABS.some((t) => t[0] === c.tab) ? c.tab : 'branches';
  const tabs = '<div class="ntabs" role="tablist" aria-label="Project detail">' + NAV_TABS.map((t) => '<button type="button" role="tab" class="ntab' + (tab === t[0] ? ' on' : '')
    + '" data-ntab="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>').join('') + '</div>';
  const pane = tab === 'activity' ? navActivityHtml(p, c.nowMs) : tab === 'git' ? navGitHtml(p, c.nowMs) : navBranchesHtml(p, c.nowMs);
  return '<div class="ndetail-head"><div class="ndetail-title"><h2>' + esc(p.name) + '</h2><span class="chip ' + chip.cls + '">' + esc(chip.label) + '</span>'
    + (blocked ? '<span class="pill-amber">' + ringIcon() + 'Needs you</span>' : '') + '</div>' + git + review + '</div>'
    + navBriefHtml(p, c) + navSpendHtml(p) + tabs + '<div class="ntabpanel" role="tabpanel">' + pane + '</div>' + navLiveStrip(p, c.sessions, c.nowMs);
}

/** Manage projects: every project with Hide / Unhide (Sereno's own config; nothing happens to a repo). */
function navManageHtml(projects) {
  const all = (Array.isArray(projects) ? projects : []).filter((p) => p)
    .sort((a, b) => (a.hidden === true) - (b.hidden === true) || String(a.name).localeCompare(String(b.name)));
  const nh = all.filter((p) => p.hidden === true).length;
  return '<section class="nmanage" aria-label="Manage projects"><h2>Manage projects</h2><p class="summary">' + (all.length - nh) + ' visible · ' + nh + ' hidden. Hiding a project only removes it from this view.</p>'
    + '<ul class="nmanage-list">' + all.map((p) => '<li><span class="nname">' + esc(p.name) + '</span>' + (p.hidden === true ? '<span class="quiet-text">hidden</span>' : '')
      + '<button type="button" class="btn-copy" data-act="' + (p.hidden === true ? 'unhide' : 'hide') + '" data-id="' + esc(p.id) + '">' + (p.hidden === true ? 'Unhide' : 'Hide') + '</button></li>').join('') + '</ul></section>';
}

/**
 * The whole Projects body below the title row. ctx: { projects, counts, sessions, ui: { filter, q, sort, open, tab, managing },
 * sel, nowMs, opts, pluginMissing }. Every API string goes through esc().
 */
function navPage(ctx) {
  const all = Array.isArray(ctx.projects) ? ctx.projects : [];
  if (!all.length) return '<div class="state-panel"><h2>No projects yet</h2><p>Projects appear when a Claude Code session runs in a git repo.</p></div>';
  if (ctx.ui.managing) return navManageHtml(all);
  const sel = navResolveSel(all, ctx.sel);
  const p = all.find((x) => x && x.id === sel && x.hidden !== true) || null;
  const o = { filter: ctx.ui.filter, q: ctx.ui.q, sort: ctx.ui.sort, open: ctx.ui.open, sel, nowMs: ctx.nowMs };
  const detail = navDetailHtml(p, { nowMs: ctx.nowMs, sid: p ? liveSessionId(p.id, all, ctx.sessions) : null, opts: ctx.opts, tab: ctx.ui.tab, pluginMissing: ctx.pluginMissing, sessions: ctx.sessions });
  return '<p class="summary">' + esc(navSummary(ctx.counts, all)) + '</p><div class="pnav">'
    + '<div class="nleft">' + navControlsHtml(navCounts(all), o) + '<div class="nlist" id="nlist">' + navListHtml(all, o) + '</div></div>'
    + '<section class="ndetail" id="ndetail" aria-label="Project detail">' + detail + '</section></div>';
}

/* ---------- Pipeline tab: pure helpers (Phase 4b step 6). Observe only; amber only for a pending decision. ---------- */

const OUTCOME_LABEL = { pass: 'Pass', block: 'Block', needs_context: 'Needs context', error: 'Error', skipped: 'Skipped' };
const ROLE_LABEL = { builder: 'Builder', 'red-team': 'Red team', scribe: 'Scribe', main: 'Main', auxiliary: 'Auxiliary', unattributed: 'Unattributed' };
const PIPE_ROLE_KEYS = ['builder', 'red-team', 'scribe'];
const PIPE_COLS = [['plan', 'Plan', 'Architect'], ['build', 'Build', 'Builder'], ['review', 'Review', 'Red team'], ['merge', 'Merge', '']];
const PIPE_SUBS = [['work', 'Work'], ['signals', 'Signals'], ['routing', 'Routing']];
const IDLE_LABEL = { 'no-task': 'No active task', 'gate-off': 'Gate off', 'latest-pass': 'Latest review passed', 'config-error': 'Config unreadable' };
const INSTALL_CMDS = ['/plugin marketplace add homestockr/sereno', '/plugin install sereno@sereno'];

/** Dollars (a number) as '$1.23 est.'; '' when there is no figure. */
function usdEst(usd) {
  return typeof usd === 'number' && Number.isFinite(usd) ? estMoney(usd * 1e6) : '';
}

/** A task waiting on the user: stage 'decision' and not expired (expired is grey, never amber). */
function isOpenDecision(t) {
  return !!t && t.stage === 'decision' && t.expired !== true;
}

/** A task that is (or was) in a repair loop. */
function isRepair(t) {
  return !!t && (/^Fixing /.test(String(t.step || '')) || Number(t.attempt) > 1);
}

/** Header counts over the /api/pipeline body. */
function pipelineCounts(body) {
  const tasks = [];
  for (const p of (body && Array.isArray(body.projects) ? body.projects : [])) {
    for (const t of (p && Array.isArray(p.tasks) ? p.tasks : [])) tasks.push(t);
  }
  const runs = body && body.signals ? Number(body.signals.runsThisWeek) : 0;
  return {
    active: tasks.length,
    repairs: tasks.filter((t) => t.expired !== true && isRepair(t)).length,
    decisions: tasks.filter(isOpenDecision).length,
    runs: Number.isFinite(runs) && runs > 0 ? runs : 0,
  };
}

/** Outcome as a shape, so it reads without colour: pass dot, block slashed ring, needs_context question ring, error triangle, skipped dash. */
function outcomeShape(outcome) {
  const open = '<svg class="oshape oshape-' + esc(outcome) + '" viewBox="0 0 16 16" aria-hidden="true">';
  if (outcome === 'pass') return open + '<circle cx="8" cy="8" r="4.5" fill="currentColor"/></svg>';
  if (outcome === 'block') return open + '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.8 12.2L12.2 3.8" stroke="currentColor" stroke-width="1.4"/></svg>';
  if (outcome === 'needs_context') return open + '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M6.2 6.3c0-1.9 3.6-1.9 3.6 0 0 1.3-1.8 1.4-1.8 2.6M8 11.1v.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  if (outcome === 'error') return open + '<path d="M8 2.5L14 13H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  if (outcome === 'skipped') return open + '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  return open + '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/></svg>';
}

/** Findings list (collapsed): severity, kind, file:line, summary. Every string escaped; '' when none. */
function findingsHtml(findings, open) {
  const list = Array.isArray(findings) ? findings : [];
  if (!list.length) return '';
  return '<details class="pfind"' + (open === true ? ' open' : '') + '><summary>' + list.length + (list.length === 1 ? ' finding' : ' findings') + '</summary><ul>'
    + list.map((f) => {
      const loc = f && f.file ? esc(f.file) + (f.line !== null && Number.isFinite(f.line) ? ':' + esc(f.line) : '') : '';
      return '<li><span class="sev">' + esc(f && f.severity ? f.severity : '—') + '</span>'
        + '<span class="fkind">' + esc(f && f.kind ? f.kind : '') + '</span>'
        + (loc ? '<span class="mono floc">' + loc + '</span>' : '')
        + '<span class="fsum">' + esc(f && f.summary ? f.summary : '') + '</span></li>';
    }).join('') + '</ul></details>';
}

/** The project's brief for a task (branch task/<name>), or null. */
function taskBrief(project, task) {
  if (!project || !task) return null;
  const want = 'task/' + task;
  const b = (Array.isArray(project.branches) ? project.branches : []).find((x) => x && x.name === want);
  if (!b || b.freshness === 'none' || b.freshness == null) return null;
  return { at: b.generatedAt != null && Number.isFinite(Number(b.generatedAt)) ? Number(b.generatedAt) : null };
}

/** Gate-state line for one project (shape + label + task + age). */
function gateLine(name, g, nowMs) {
  if (!g) return '<li class="gline"><strong>' + esc(name) + '</strong><span class="quiet-text">No review in 30 days</span></li>';
  const age = relTime(Number(nowMs) - Number(g.ageMs), nowMs);
  return '<li class="gline">' + outcomeShape(g.outcome) + '<strong>' + esc(name) + '</strong><span>' + esc(OUTCOME_LABEL[g.outcome] || g.outcome || 'Unknown') + '</span>'
    + '<span class="mono">' + esc(g.task) + '</span>' + (age ? '<span class="quiet-text">' + esc(age) + '</span>' : '') + '</li>';
}

/** Outcome mix over the fixed 30 days; every count carries n. */
function outcomesHtml(o) {
  const n = o && Number(o.n) > 0 ? Math.floor(Number(o.n)) : 0;
  if (!n) return '<p class="empty-note">No review runs in the last 30 days (n=0)</p>';
  return '<ul class="outcomes">' + ['pass', 'block', 'needs_context', 'error', 'skipped'].map((k) => {
    const c = Number(o[k]) > 0 ? Math.floor(Number(o[k])) : 0;
    return '<li>' + outcomeShape(k) + '<span>' + esc(OUTCOME_LABEL[k]) + '</span><strong class="num">' + c + ' of ' + n + '</strong>'
      + '<span class="quiet-text num">' + Math.round((c / n) * 100) + '% · n=' + n + '</span></li>';
  }).join('') + '</ul>';
}

/** Rework: review runs before the first pass. */
function reworkLine(r) {
  const n = r && Number(r.n) > 0 ? Math.floor(Number(r.n)) : 0;
  const ex = r && Number(r.excluded) > 0 ? Math.floor(Number(r.excluded)) : 0;
  const tail = 'n=' + n + (ex ? ', ' + ex + ' excluded (no pass yet)' : '');
  if (!n || r.median == null) return 'Rework: — (' + tail + ')';
  return 'Rework: median ' + r.median + ' · max ' + r.max + ' reruns before a pass (' + tail + ')';
}

/** Red-team cost per merge: an estimate, an em dash when there is no mean. */
function perMergeLine(m) {
  const n = m && Number(m.n) > 0 ? Math.floor(Number(m.n)) : 0;
  const ex = m && Number(m.excluded) > 0 ? Math.floor(Number(m.excluded)) : 0;
  const tail = 'n=' + n + (ex ? ', ' + ex + ' excluded' : '');
  const v = m && m.mean != null ? usdEst(Number(m.mean)) : '';
  return 'Red team per merge: ' + (v || '—') + ' (' + tail + ')';
}

/** Role spend share with its attribution mix. Not enabled -> the history-off note. */
function roleSpendHtml(rs) {
  if (!rs || rs.enabled !== true) return '<p class="empty-note">Spend history is off</p>';
  const roles = rs.roles || {};
  const keys = PIPE_ROLE_KEYS;   // the three pipeline roles; main, auxiliary and unattributed live in the Spend tab
  const costs = keys.map((k) => (roles[k] && Number(roles[k].costUsd) > 0 ? Number(roles[k].costUsd) : 0));
  const days = Number(rs.days) || 30;
  if (costs.reduce((a, b) => a + b, 0) <= 0) return '<p class="empty-note">No spend in the last ' + days + ' days</p>';
  const pct = largestRemainder(costs);
  return '<ul class="rspend">' + keys.map((k, i) => {
    if (costs[i] <= 0) return '';
    const r = roles[k];
    const mix = [Number(r.explicit) || 0, Number(r.inferred) || 0, Number(r.unattributed) || 0];
    const mp = largestRemainder(mix);
    return '<li><strong>' + esc(ROLE_LABEL[k]) + '</strong><span class="num">' + esc(usdEst(costs[i])) + '</span><span class="num">' + pct[i] + '% of pipeline spend</span>'
      + (mix[0] + mix[1] + mix[2] > 0 ? '<span class="quiet-text num">' + mp[0] + '% explicit · ' + mp[1] + '% inferred · ' + mp[2] + '% unattributed</span>' : '') + '</li>';
  }).join('') + '</ul><p class="quiet-text rnote">Last ' + days + ' days · estimates from the local ledger</p>';
}

/** Friendly model name from the family word in the id (Haiku, Sonnet, Opus, Fable); the raw id when none matches; '' when empty. */
function modelName(id) {
  const raw = typeof id === 'string' ? id.trim() : '';
  const m = /haiku|sonnet|opus|fable/i.exec(raw);
  return m ? m[0].charAt(0).toUpperCase() + m[0].slice(1).toLowerCase() : raw;
}

/** Model cell markup: the friendly name, with the raw id in quieter text when it adds something. */
function modelHtml(id) {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (!raw) return '—';
  const n = modelName(raw);
  return esc(n) + (n.toLowerCase() !== raw.toLowerCase() ? ' <span class="quiet-text mono">' + esc(raw) + '</span>' : '');
}

/** Role routing: agent, role, model; then each project's red-team agent and fallback. */
function routingHtml(routing, projects) {
  const models = routing && Array.isArray(routing.models) ? routing.models : [];
  const names = {};
  for (const p of (Array.isArray(projects) ? projects : [])) if (p) names[p.id] = p.name;
  const rt = (routing && Array.isArray(routing.projects) ? routing.projects : []).filter((p) => p && p.redTeam);
  const dash = (v) => esc(v == null || v === '' ? '—' : v);
  return '<div class="table-wrap"><table class="route-table"><thead><tr><th>Agent</th><th>Role</th><th>Model</th></tr></thead><tbody>'
    + (models.length ? models.map((m) => '<tr><td class="mono">' + dash(m.agent) + '</td><td>' + dash(ROLE_LABEL[m.role] || m.role) + '</td><td>' + modelHtml(m.model) + '</td></tr>').join('')
      : '<tr><td colspan="3" class="quiet-text">No agents found</td></tr>')
    + '</tbody></table></div>'
    + (rt.length ? '<div class="table-wrap"><table class="route-table"><thead><tr><th>Project</th><th>Red-team agent</th><th>Fallback</th><th>On fallback</th></tr></thead><tbody>'
      + rt.map((p) => '<tr><td>' + dash(names[p.id] || p.id) + '</td><td class="mono">' + dash(p.redTeam.agent) + '</td><td class="mono">' + dash(p.redTeam.fallback)
        + '</td><td>' + dash(p.redTeam.onFallback) + '</td></tr>').join('') + '</tbody></table></div>' : '');
}

/** The install empty state: the two commands, each with a copy button. */
function installHtml() {
  return '<div class="state-panel install"><h2>The Sereno pipeline plugin is not detected</h2>'
    + '<p>Install it in Claude Code, then this tab fills in. Sereno only observes what the plugin writes.</p>'
    + INSTALL_CMDS.map(cmdRow).join('')
    + '</div>';
}

/** True when the body shows any pipeline activity or configuration at all. */
function pipelineHasData(body) {
  if (!body) return false;
  if ((body.projects || []).some((p) => p && Array.isArray(p.tasks) && p.tasks.length)) return true;
  if (body.signals && body.signals.outcomes && Number(body.signals.outcomes.n) > 0) return true;
  return !!(body.routing && Array.isArray(body.routing.projects) && body.routing.projects.some((p) => p && p.redTeam));
}

/* ---------- Pipeline tab: one-screen layout (Phase 4b addendum, L2). Observe only; amber only for a pending decision. ---------- */

const MARK_TEXT = { done: 'done', current: 'in progress', waiting: 'waiting', block: 'review blocked', needs_context: 'needs context', error: 'review error' };
const STAGE_FILTERS = [['all', 'All stages'], ['plan', 'Plan'], ['build', 'Build'], ['review', 'Review'], ['merge', 'Merge']];

/** The small neutral label on the current Build step: "Building", "Fixing N", "Env. retry"; '' otherwise. */
function buildLabel(step) {
  const s = String(step == null ? '' : step);
  const m = /^Fixing (\d+)/.exec(s);
  if (m) return 'Fixing ' + m[1];
  if (/^Retrying/.test(s)) return 'Env. retry';
  return s === 'Building' ? 'Building' : '';
}

/**
 * The four track cells for a task: { key, label, role, mark, dec, tag }.
 * mark: done | current | waiting | block | needs_context | error. dec is true only for an open
 * decision (the Review node). tag is the small neutral label (never coloured by state).
 */
function trackMarks(t) {
  const stage = t ? t.stage : null;
  const cur = { architect: 0, builder: 1, 'red-team': 2, decision: 2, ready: 3 }[stage];
  const at = cur === undefined ? -1 : cur;
  const oc = t && t.gate && t.gate.outcome ? t.gate.outcome : '';
  const bad = oc === 'block' || oc === 'needs_context' || oc === 'error' ? oc : '';
  return PIPE_COLS.map((c, i) => {
    let mark = at < 0 ? 'waiting' : i < at ? 'done' : i === at ? 'current' : 'waiting';
    let dec = false;
    if (i === 2 && stage === 'decision') { mark = bad || 'needs_context'; dec = isOpenDecision(t); }
    else if (i === 2 && stage === 'builder' && bad) mark = bad;   // the last review said no; the Builder is fixing it
    let tag = '';
    if (i === 1 && mark === 'current') tag = buildLabel(t.step);
    if (i === 3 && mark === 'current') tag = 'Ready';
    return { key: c[0], label: c[1], role: c[2], mark, dec, tag };
  });
}

/** One track mark as a shape: done check, current node, waiting ring, block slash, question ring, error triangle. */
function markSvg(mark, key, dec) {
  const cls = 'mk mk-' + esc(mark) + ' role-' + esc(key) + (dec ? ' mk-dec' : '');
  const open = '<svg class="' + cls + '" viewBox="0 0 16 16" aria-hidden="true">';
  const ring = '<circle class="bg" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>';
  if (mark === 'done') return open + '<circle cx="8" cy="8" r="7" fill="currentColor"/><path class="chk" d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (mark === 'current') return open + '<circle cx="8" cy="8" r="5.5" fill="currentColor"/></svg>';
  if (mark === 'block') return open + ring + '<path d="M3.8 12.2L12.2 3.8" stroke="currentColor" stroke-width="1.4"/></svg>';
  if (mark === 'needs_context') return open + ring + '<path d="M6.2 6.3c0-1.9 3.6-1.9 3.6 0 0 1.3-1.8 1.4-1.8 2.6M8 11.1v.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  if (mark === 'error') return open + '<path class="bg" d="M8 2.5L14 13H2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  return open + ring + '</svg>';
}

/** Which filter group a task belongs to: plan | build | review | merge, '' when unknown. */
function stageGroup(t) {
  const g = { architect: 'plan', builder: 'build', 'red-team': 'review', decision: 'review', ready: 'merge' }[t ? t.stage : ''];
  return g || '';
}

/** Table rows after the project and stage filters; expired rows come last. Row: { key, project, t }. */
function pipeRows(body, f) {
  const fp = f && f.project ? f.project : 'all';
  const fg = f && f.stage ? f.stage : 'all';
  const active = [];
  const expired = [];
  for (const p of (body && Array.isArray(body.projects) ? body.projects : [])) {
    if (!p || (fp !== 'all' && p.id !== fp)) continue;
    for (const t of (Array.isArray(p.tasks) ? p.tasks : [])) {
      if (!t || (fg !== 'all' && stageGroup(t) !== fg)) continue;
      (t.expired === true ? expired : active).push({ key: String(p.id) + '/' + String(t.task), project: p, t });
    }
  }
  return active.concat(expired);
}

/** The selected row: the remembered key if still listed, else the first open decision, else the first row. */
function resolveSel(rows, sel) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find((r) => r.key === sel) || list.find((r) => isOpenDecision(r.t)) || list[0] || null;
}

/** Arrow-key movement: the key of the row dir (-1 or 1) away from the selection, clamped; null with no rows. */
function moveSel(rows, sel, dir) {
  const list = Array.isArray(rows) ? rows : [];
  const cur = resolveSel(list, sel);
  if (!cur) return null;
  const i = Math.max(0, Math.min(list.length - 1, list.indexOf(cur) + (dir < 0 ? -1 : 1)));
  return list[i].key;
}

/** One ~34px table row: task + project, branch, the four track cells, cost. */
function rowHtml(r, selKey) {
  const t = r.t;
  const open = isOpenDecision(t);
  const exp = t.expired === true;
  const cells = trackMarks(t).map((m) => {
    const what = m.dec ? 'needs a decision' : (MARK_TEXT[m.mark] || m.mark);
    return '<div class="tcell tc-' + m.key + '" role="gridcell"><span class="tmark" role="img" aria-label="' + esc(m.label + ': ' + what + (m.tag ? ', ' + m.tag : '')) + '">'
      + markSvg(m.mark, m.key, m.dec) + (m.tag ? '<span class="tlabel' + (m.key === 'build' ? ' tchip' : '') + '">' + esc(m.tag) + '</span>' : '') + '</span></div>';
  }).join('');
  const money = usdEst(t.costUsd);
  const on = r.key === selKey;
  return '<div class="prow' + (on ? ' sel' : '') + (open ? ' decision' : '') + (exp ? ' expired' : '') + '" role="row" tabindex="0" data-sel="' + esc(r.key)
    + '" aria-selected="' + on + '">'
    + '<div class="pcell-task" role="gridcell"><span class="ptname">' + esc(t.task) + '</span><span class="ptproj">' + esc(r.project.name) + (exp ? ' · expired' : '') + '</span></div>'
    + '<div class="pcell-branch mono" role="gridcell">task/' + esc(t.task) + '</div>' + cells
    + '<div class="pcell-cost num" role="gridcell">' + (money ? esc(money) : '') + '</div></div>';
}

/** Project and stage filters (no search). */
function pipeFiltersHtml(body, ui) {
  const projs = (body && Array.isArray(body.projects) ? body.projects : []).filter((p) => p && p.id != null);
  const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
  return '<div class="pfilters"><label>Project <select data-pf="project" aria-label="Project">' + opt('all', 'All projects', ui.project)
    + projs.map((p) => opt(p.id, p.name, ui.project)).join('') + '</select></label>'
    + '<label>Stage <select data-pf="stage" aria-label="Stage">' + STAGE_FILTERS.map((s) => opt(s[0], s[1], ui.stage)).join('') + '</select></label></div>';
}

/** The collapsed "Idle repositories (N)" row; the idle lines show when it opens. '' when there are none. */
function idleHtml(body, ui) {
  const idle = (body && Array.isArray(body.projects) ? body.projects : [])
    .filter((p) => p && p.idle && !(Array.isArray(p.tasks) && p.tasks.length) && (ui.project === 'all' || p.id === ui.project));
  if (!idle.length) return '';
  return '<details class="pidle"' + (ui.open && ui.open.idle ? ' open' : '') + '><summary>Idle repositories (' + idle.length + ')</summary><ul class="idle">'
    + idle.map((p) => '<li><strong>' + esc(p.name) + '</strong><span class="quiet-text">' + esc(IDLE_LABEL[p.idle] || IDLE_LABEL['no-task']) + '</span></li>').join('') + '</ul></details>';
}

/** One outcome shape per review in the window, oldest first so the newest is last. '' with none. Unknown outcomes are skipped. */
function outcomeDotsHtml(seq) {
  const ok = ['pass', 'block', 'needs_context', 'error', 'skipped'];
  const list = (Array.isArray(seq) ? seq : []).filter((k) => ok.includes(k)).slice(-60);
  if (!list.length) return '';
  return '<span class="odots" role="img" aria-label="Last ' + list.length + ' reviews, newest last">'
    + list.map((k) => '<span class="odot" title="' + esc(OUTCOME_LABEL[k] || k) + '">' + outcomeShape(k) + '</span>').join('') + '</span>';
}

/** Bottom strip: outcome shapes with n, rework (n), red-team cost per merge (est., n, excluded), link to Signals. */
function stripHtml(body) {
  const sg = body && body.signals ? body.signals : {};
  const o = sg.outcomes || {};
  const n = Number(o.n) > 0 ? Math.floor(Number(o.n)) : 0;
  const outs = n
    ? ['pass', 'block', 'needs_context', 'error', 'skipped'].map((k) => {
      const c = Number(o[k]) > 0 ? Math.floor(Number(o[k])) : 0;
      return '<span class="soc">' + outcomeShape(k) + esc(OUTCOME_LABEL[k]) + ' <strong class="num">' + c + '</strong></span>';
    }).join('') + '<span class="quiet-text num">n=' + n + '</span>'
    : '<span class="quiet-text num">No review runs in 30 days (n=0)</span>';
  return '<div class="pstrip">' + outcomeDotsHtml(sg.seq) + '<span class="sgroup">' + outs + '</span><span class="sgroup">' + esc(reworkLine(sg.rework)) + '</span>'
    + '<span class="sgroup">' + esc(perMergeLine(body ? body.redTeamPerMerge : null)) + '</span>'
    + '<a class="slink" href="#pipeline/signals">Signals</a></div>';
}

/** The Work sub-tab: filters, the table, idle repositories, the bottom strip. */
function workHtml(body, ui) {
  const all = pipeRows(body, { project: 'all', stage: 'all' });
  const rows = pipeRows(body, ui);
  const sel = resolveSel(rows, ui.sel);
  const head = '<div class="phead-row" role="row"><div role="columnheader">Task</div><div role="columnheader">Branch</div>'
    + PIPE_COLS.map((c) => '<div class="tcell" role="columnheader">' + esc(c[1]) + (c[2] ? '<span class="trole">' + esc(c[2]) + '</span>' : '') + '</div>').join('') + '<div class="pcell-cost" role="columnheader">Cost</div></div>';
  const table = rows.length
    ? '<div class="ptable" role="grid" aria-label="Active tasks">' + head + rows.map((r) => rowHtml(r, sel ? sel.key : null)).join('') + '</div>'
    : '<p class="empty-note">' + (all.length ? 'No tasks match these filters' : 'No active tasks') + '</p>';
  return pipeFiltersHtml(body, ui) + table + idleHtml(body, ui) + stripHtml(body);
}

/** Signals sub-tab: gate state per project, 30-day outcomes, rework, red-team cost per merge, role spend. */
function signalsHtml(body, nowMs, open) {
  const names = {};
  for (const p of (body && Array.isArray(body.projects) ? body.projects : [])) if (p) names[p.id] = p.name;
  const sg = body.signals || {};
  const gp = Array.isArray(sg.projects) ? sg.projects : [];
  const gates = gp.filter((g) => g && g.gate).map((g) => gateLine(names[g.id] || g.id || 'Unknown project', g.gate, nowMs));
  const quiet = gp.filter((g) => g && !g.gate).map((g) => '<li>' + esc(names[g.id] || g.id || 'Unknown project') + '</li>');
  const days = Number(sg.days) || 30;
  const gateBox = (gates.length ? '<ul class="glist ggrid">' + gates.join('') + '</ul>' : '')
    + (quiet.length ? '<details class="pidle"' + (open && open.quiet ? ' open' : '') + '><summary>' + quiet.length + (quiet.length === 1 ? ' project' : ' projects') + ' with no review in ' + days + ' days</summary><ul class="idle quiet-list">' + quiet.join('') + '</ul></details>' : '')
    + (gp.length ? '' : '<p class="empty-note">No projects</p>');
  return '<div class="sig"><h3>Gate state</h3>' + gateBox + '</div>'
    + '<div class="sig"><h3>Review outcomes<span class="sub"> Last ' + (Number(sg.days) || 30) + ' days</span></h3>' + outcomesHtml(sg.outcomes) + '</div>'
    + '<div class="sig"><h3>Rework and cost</h3><p>' + esc(reworkLine(sg.rework)) + '</p><p>' + esc(perMergeLine(body.redTeamPerMerge)) + '</p></div>'
    + '<div class="sig"><h3>Spend by pipeline role</h3>' + roleSpendHtml(body.roleSpend) + '</div>';
}

/** Routing sub-tab: role to model, and each project's red-team policy. */
function routingTabHtml(body) {
  return '<div class="sig"><h3>Role routing</h3>' + routingHtml(body.routing, body.projects) + '</div>';
}

/** Sub-tab links, kept in the route. */
function subtabsHtml(sub) {
  return '<nav class="spills" aria-label="Pipeline views">' + PIPE_SUBS.map((s) => '<a class="spill' + (s[0] === sub ? ' on' : '') + '" href="#pipeline' + (s[0] === 'work' ? '' : '/' + s[0])
    + '"' + (s[0] === sub ? ' aria-current="page"' : '') + '>' + esc(s[1]) + '</a>').join('') + '</nav>';
}

/** Normalised UI state: sub, project, stage, sel, open. A project or stage no longer in the data falls back to 'all'. */
function pipeUi(ui, body) {
  const u = ui && typeof ui === 'object' ? ui : {};
  let project = typeof u.project === 'string' && u.project ? u.project : 'all';
  let stage = typeof u.stage === 'string' && u.stage ? u.stage : 'all';
  if (project !== 'all' && body && Array.isArray(body.projects) && !body.projects.some((p) => p && p.id === project)) project = 'all';
  if (stage !== 'all' && !STAGE_FILTERS.some((s) => s[0] === stage)) stage = 'all';
  return {
    sub: u.sub === 'signals' || u.sub === 'routing' ? u.sub : 'work',
    project, stage,
    sel: typeof u.sel === 'string' ? u.sel : null,
    open: u.open && typeof u.open === 'object' ? { idle: u.open.idle === true, quiet: u.open.quiet === true } : { idle: false, quiet: false },
  };
}

/** The whole Pipeline view body (below the title row). */
function pipelineBody(body, projectsList, ui, nowMs) {
  if (!body) return '<div class="state-panel"><h2>Pipeline is unavailable right now</h2><p>Sereno will try again on the next refresh.</p></div>';
  const plugin = body.plugin;
  const installed = !!plugin && plugin.installed !== false;
  if (!pipelineHasData(body) && !installed) return installHtml();
  const u = pipeUi(ui, body);
  const c = pipelineCounts(body);
  const summary = c.active + (c.active === 1 ? ' active task' : ' active tasks') + ' · ' + c.repairs + (c.repairs === 1 ? ' repair' : ' repairs') + ' · '
    + c.decisions + (c.decisions === 1 ? ' decision' : ' decisions') + ' · ' + c.runs + (c.runs === 1 ? ' run' : ' runs') + ' this week';
  const content = u.sub === 'signals' ? signalsHtml(body, nowMs, u.open) : u.sub === 'routing' ? routingTabHtml(body) : workHtml(body, u);
  return '<p class="summary">' + esc(summary) + '</p>' + subtabsHtml(u.sub) + content;
}

/** A live top-level session id inside the project's repo (from /api/projects p.live.sessionIds and /state), or null. */
function liveSessionId(projectId, projectsList, sessions) {
  const p = (Array.isArray(projectsList) ? projectsList : []).find((x) => x && x.id === projectId);
  const ids = p && p.live && Array.isArray(p.live.sessionIds) ? p.live.sessionIds : [];
  const hit = topSessions({ sessions }).find((s) => !s.stale && typeof s.id === 'string' && ids.indexOf(s.id) >= 0);
  return hit ? hit.id : null;
}

/** Text for one timeline step. */
function timelineText(m, t) {
  if (m.dec) return 'Needs a decision';
  const oc = t && t.gate && t.gate.outcome ? (OUTCOME_LABEL[t.gate.outcome] || t.gate.outcome) : '';
  if (m.mark === 'block' || m.mark === 'needs_context' || m.mark === 'error') return 'Review: ' + (OUTCOME_LABEL[m.mark] || m.mark);
  if (m.mark === 'waiting') return 'Waiting';
  if (m.mark === 'current') return m.tag || (m.key === 'review' ? 'In review' : m.key === 'plan' ? 'Spec written' : 'In progress');
  if (m.key === 'plan') return 'Spec written';
  if (m.key === 'build') return 'Built';
  return m.key === 'review' ? (oc ? 'Review: ' + oc : 'Reviewed') : 'Done';
}

/** One activity line from the API's { at, kind, outcome }; '' for an unknown kind. */
function activityText(e) {
  const oc = e && e.outcome ? (OUTCOME_LABEL[e.outcome] || e.outcome) : '';
  if (!e) return '';
  if (e.kind === 'spec') return 'Spec written';
  if (e.kind === 'attempt-start') return 'Attempt started';
  if (e.kind === 'attempt-end') return 'Attempt ended' + (oc ? ': ' + oc : '');
  if (e.kind === 'gate') return 'Review' + (oc ? ': ' + oc : '');
  return '';
}

/**
 * The selected-task panel. ctx: { project: /api/projects entry or null, sid: live session id or null,
 * pinned: session ids already offered in the pinned decision block, opts: reviewControl opts, nowMs }.
 */
function panelHtml(row, ctx) {
  if (!row) return '';
  const t = row.t;
  const c = ctx || {};
  const nowMs = c.nowMs;
  const open = isOpenDecision(t);
  const exp = t.expired === true;
  const marks = trackMarks(t);
  const acts = Array.isArray(t.activity) ? t.activity : [];
  const specAt = acts.find((e) => e && e.kind === 'spec');
  const starts = (Array.isArray(t.attempts) ? t.attempts : []).map((a) => Number(a && a.startedAt)).filter(Number.isFinite);
  const firstStart = typeof t.firstStartedAt === 'number' && Number.isFinite(t.firstStartedAt) ? t.firstStartedAt : (starts.length ? Math.min.apply(null, starts) : null);   // attempts is capped; firstStartedAt covers all of them
  const gateAt = t.gate && t.gate.reviewed_at ? Date.parse(t.gate.reviewed_at) : NaN;
  const times = { plan: specAt ? specAt.at : null, build: firstStart, review: Number.isFinite(gateAt) ? gateAt : null, merge: null };
  const pill = open
    ? '<span class="pill-amber">' + ringIcon() + 'Needs a decision</span>'
    : '<span class="pill-neutral">' + esc(exp ? 'Expired' : (t.step || 'Status unavailable')) + '</span>';
  const tl = '<ol class="ptl">' + marks.map((m) => {
    const when = times[m.key] != null ? relTime(times[m.key], nowMs) : '';
    return '<li class="ptl-' + esc(m.mark) + (m.dec ? ' ptl-dec' : '') + '">' + markSvg(m.mark, m.key, m.dec)
      + '<span class="ptl-name">' + esc(m.label + (m.role ? ' · ' + m.role : '')) + '</span><span class="ptl-stat">' + esc(timelineText(m, t)) + '</span>'
      + (when ? '<span class="ptl-time quiet-text">' + esc(when) + '</span>' : '') + '</li>';
  }).join('') + '</ol>';
  const runs = Number(t.reviewRuns) > 0 ? Math.floor(Number(t.reviewRuns)) : 0;
  const money = usdEst(t.costUsd);
  const started = relTime(t.startedAt, nowMs);
  const brief = taskBrief(c.project, t.task);
  const briefText = brief ? (brief.at !== null ? 'Updated ' + relTime(brief.at, nowMs) : 'On this branch') : 'No brief';
  const kv = '<dl class="pkv"><dt>Cost</dt><dd class="num">' + (money ? esc(money) : '—') + '</dd>'
    + '<dt>Review runs</dt><dd class="num">' + runs + '</dd>'
    + '<dt>Started</dt><dd>' + (started ? esc(started) : '—') + '</dd>'
    + '<dt>Builder model</dt><dd' + (t.builderModel ? ' title="' + esc(t.builderModel) + '"' : '') + '>' + (t.builderModel ? esc(modelName(t.builderModel)) : '—') + '</dd>'
    + '<dt>Brief</dt><dd>' + esc(briefText) + '</dd></dl>';
  const pinned = Array.isArray(c.pinned) ? c.pinned : [];
  const review = c.sid && pinned.indexOf(c.sid) < 0 ? reviewControl({ sessionId: c.sid }, c.opts) : '';
  const attempts = Array.isArray(t.attempts) ? t.attempts : [];
  const attList = attempts.length
    ? '<h4>Attempts</h4><ul class="plist2">' + attempts.map((a) => {
      const s = a && a.startedAt != null ? relTime(a.startedAt, nowMs) : '';
      const e = a && a.endedAt != null ? relTime(a.endedAt, nowMs) : '';
      return '<li><span class="num">#' + esc(a && a.attempt != null ? a.attempt : '?') + '</span><span>' + esc(a && a.outcome ? (OUTCOME_LABEL[a.outcome] || a.outcome) : '—') + '</span>'
        + '<span class="quiet-text">' + (s ? 'started ' + esc(s) : '') + (e ? ' · ended ' + esc(e) : '') + '</span></li>';
    }).join('') + '</ul>' : '';
  const actLines = acts.map((e) => ({ e, line: activityText(e) })).filter((x) => x.line);
  const actList = actLines.length
    ? '<h4>Recent activity</h4><ul class="plist2">' + actLines.map((x) => '<li><span>' + esc(x.line) + '</span><span class="quiet-text">' + esc(relTime(x.e.at, nowMs)) + '</span></li>').join('') + '</ul>' : '';
  const find = Array.isArray(t.findings) && t.findings.length ? '<h4>Latest findings</h4>' + findingsHtml(t.findings, true) : '';
  return '<section class="ppanel' + (open ? ' ppanel-dec' : '') + '" aria-label="Selected task"><div class="ppanel-head"><h2 class="mono">' + esc(t.task) + '</h2>' + pill + '</div>'
    + '<div class="ppanel-sub"><span>' + esc(row.project.name) + '</span><span class="mono">task/' + esc(t.task) + '</span></div>'
    + tl + kv + review + find + attList + actList + '</section>';
}

/**
 * The right column on the Pipeline tab: the pinned attention block (a decision, or a stalled note) and,
 * on the Work sub-tab, the selected-task panel. ctx: { sessions, projectsList, opts, nowMs }.
 */
function pipelineSideHtml(st, body, ui, ctx) {
  const p = pipelineSideParts(st, body, ui, ctx);
  return p.panel ? p.attn + p.panel : p.attn;
}

/** The two halves of the right column: attn (the live-region block) and panel (the selected task, outside the live region). */
function pipelineSideParts(st, body, ui, ctx) {
  const c = ctx || {};
  const u = pipeUi(ui, body);
  const pinned = st && !st.unavailable && (st.amber || (Array.isArray(st.stalled) && st.stalled.length)) ? attentionHtml(st, c.nowMs, c.opts) : '';
  let panel = '';
  if (body && u.sub === 'work' && (pipelineHasData(body) || (body.plugin && body.plugin.installed !== false))) {
    const row = resolveSel(pipeRows(body, u), u.sel);
    if (row) {
      const sids = [];
      for (const d of (st && Array.isArray(st.decisions) ? st.decisions : [])) if (d.sessionId) sids.push(d.sessionId);
      panel = panelHtml(row, { project: (Array.isArray(c.projectsList) ? c.projectsList : []).find((p) => p && p.id === row.project.id) || null,
        sid: liveSessionId(row.project.id, c.projectsList, c.sessions), pinned: sids, opts: c.opts, nowMs: c.nowMs });
    }
  }
  return pinned || panel ? { attn: pinned, panel } : { attn: attentionHtml(st || { amber: false, count: 0, items: [] }, c.nowMs, c.opts), panel: '' };
}

/* ---------- Spend tab: pure helpers (alpha.6 S2) ---------- */

const SPEND_SUBS = ['overview', 'projects', 'turns', 'cache'];
const SPEND_SUB_LABEL = { overview: 'Overview', projects: 'Projects', turns: 'Turns', cache: 'Cache' };
const CACHE_WINDOWS = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];

/** Non-negative finite number, else 0. */
function nz(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * '#spend', '#spend/projects', '#spend/turns?p=name' -> { sub, sel }. Strict: anything that is not exactly
 * one of those (extra segments, a second parameter, control characters, an over-long or bad-escape name)
 * gives the Overview and no selection, never a guess.
 */
function parseSpendHash(hash) {
  const raw = String(hash == null ? '' : hash).replace(/^#\/?/, '').trim();
  const m = /^spend(?:\/(projects|turns|cache))?(?:\?p=([^&#?]{1,1800}))?$/i.exec(raw);
  if (!m) return { sub: 'overview', sel: null };
  let sel = null;
  if (m[2]) {
    try { sel = decodeURIComponent(m[2]); } catch (_) { sel = null; }
    if (sel !== null && (sel.trim() === '' || sel.length > 200 || /[\u0000-\u001f\u007f]/.test(sel))) sel = null;
  }
  return { sub: m[1] ? m[1].toLowerCase() : 'overview', sel };
}

/** The hash for a sub-tab and an optional selected project (the inverse of parseSpendHash). */
function spendHash(sub, sel) {
  const s = SPEND_SUBS.indexOf(sub) > 0 ? '/' + sub : '';
  return '#spend' + s + (typeof sel === 'string' && sel !== '' && sel.length <= 200 ? '?p=' + encodeURIComponent(sel) : '');
}

/** The API's project rows, biggest spend first (stable for ties). */
function spendRows(where) {
  const rows = where && Array.isArray(where.rows) ? where.rows.filter((r) => r && typeof r === 'object') : [];
  return rows.slice().sort((a, b) => nz(b.costMicros) - nz(a.costMicros));
}

/** Top n projects plus an Other roll-up of everything else (the rest of the rows and the API's own Other). */
function wherePreview(where, n) {
  const rows = spendRows(where);
  const rest = rows.slice(n);
  const o = where && where.other && typeof where.other === 'object' ? where.other : {};
  return {
    rows: rows.slice(0, n),
    other: {
      count: rest.length + Math.floor(nz(o.count)),
      costMicros: rest.reduce((a, r) => a + nz(r.costMicros), 0) + nz(o.costMicros),
      requests: rest.reduce((a, r) => a + nz(r.requests), 0) + nz(o.requests),
    },
  };
}

/** Selected project name: the requested one if it is a named project in the rows, else the top named project, else null. */
function spendResolveSel(where, sel) {
  const names = spendRows(where).map((r) => r.project).filter((p) => typeof p === 'string' && p !== '');
  return typeof sel === 'string' && names.indexOf(sel) >= 0 ? sel : (names.length ? names[0] : null);
}

/** The /api/projects id for a spend project name, only when exactly one visible project has that name. */
function projectIdFor(list, name) {
  if (typeof name !== 'string' || name === '' || !Array.isArray(list)) return null;
  const ids = new Set();
  for (const p of list) {
    if (p && typeof p === 'object' && p.hidden !== true && p.name === name && typeof p.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.id)) ids.add(p.id);
  }
  return ids.size === 1 ? Array.from(ids)[0] : null;
}

/** Models cell: friendly family names (Haiku, Sonnet, Opus, Fable), each with its raw ids in the tooltip. */
function modelsHtml(models) {
  const list = (Array.isArray(models) ? models : []).filter((x) => typeof x === 'string' && x.trim() !== '');
  if (!list.length) return '<span class="quiet-text">Unknown</span>';
  const groups = new Map();
  for (const id of list) {
    const k = modelName(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id.trim());
  }
  return Array.from(groups.entries()).map(([label, ids]) => '<span class="mdl" title="' + esc(ids.join(', ')) + '">' + esc(label) + '</span>').join(', ');
}

/** 1234 -> '1.2K', 2500000 -> '2.5M'. */
function fmtTokens(n) {
  const v = nz(n);
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

/** Three source shares as a small bar (widths set from data-w); the label carries n. */
function mixBar(r) {
  const s = (r && r.bySource) || {};
  const p = largestRemainder([s.main, s.subagent, s.auxiliary]);
  const n = Math.floor(nz(r && r.requests));
  const aria = 'Main ' + p[0] + '%, subagent ' + p[1] + '%, auxiliary ' + p[2] + '% of cost, n=' + n;
  return '<span class="mixbar" role="img" aria-label="' + esc(aria) + '"><span class="seg-main" data-w="' + p[0] + '"></span>'
    + '<span class="seg-subagent" data-w="' + p[1] + '"></span><span class="seg-auxiliary" data-w="' + p[2] + '"></span></span>';
}

/** Header: title, the decision pill, and today, month-to-date and unattributed figures. */
function spendHeaderHtml(ov, pillCount) {
  const o = ov && typeof ov === 'object' ? ov : {};
  const t = o.today || {};
  const m = o.month || {};
  const month = nz(m.costMicros);
  const un = nz(m.unattributedMicros);
  const n = Math.floor(nz(m.unattributedN));
  const reqs = Math.floor(nz(m.requests));
  const pct = month > 0 ? Math.round((un / month) * 100) : 0;
  const stat = (k, v, sub) => '<div class="sstat"><dt>' + esc(k) + '</dt><dd class="num">' + esc(v) + '</dd>' + (sub ? '<dd class="sstat-sub num">' + esc(sub) + '</dd>' : '') + '</div>';
  return '<div class="title-row"><h1>Spend</h1><span id="pill-slot">' + pillHtml(pillCount) + '</span></div>'
    + '<dl class="sstats">' + stat('Today', estMoney(t.costMicros), '')
    + stat('Month to date', estMoney(m.costMicros), '')
    + stat('Unattributed, month to date', estMoney(un), n + (n === 1 ? ' request' : ' requests') + ' · ' + pct + '% of spend (n=' + reqs + ')')
    + '</dl>';
}

/** Pill sub-tabs; each link keeps the selected project in the hash. */
function spendTabsHtml(sub, sel) {
  return '<nav class="spills" aria-label="Spend views">' + SPEND_SUBS.map((k) => '<a class="spill' + (k === sub ? ' on' : '') + '" href="' + esc(spendHash(k, sel)) + '"'
    + (k === sub ? ' aria-current="page"' : '') + '>' + SPEND_SUB_LABEL[k] + '</a>').join('') + '</nav>';
}

/** "Where the spend goes" preview: top 3 plus Other, each named row selectable. */
function wherePreviewHtml(where, sel) {
  const pv = wherePreview(where, 3);
  const head = '<div class="section-top"><h2>Where the spend goes<span class="sub">Month to date</span></h2>'
    + '<a class="sall" href="' + esc(spendHash('projects', sel)) + '">All projects</a></div>';
  if (!pv.rows.length) return head + '<p class="empty-note">No project spend this month</p>';
  const items = pv.rows.map((r) => {
    const named = typeof r.project === 'string' && r.project !== '';
    const inner = '<span class="sp-name">' + esc(projectLabel(r.project)) + '</span>' + mixBar(r) + '<span class="num sp-cost">' + esc(estMoney(r.costMicros)) + '</span>';
    return '<li>' + (named
      ? '<button type="button" class="sprev' + (sel === r.project ? ' sel' : '') + '" data-ssel="' + esc(r.project) + '" aria-pressed="' + (sel === r.project) + '">' + inner + '</button>'
      : '<div class="sprev">' + inner + '</div>') + '</li>';
  });
  if (pv.other.count > 0 || pv.other.costMicros > 0) {
    items.push('<li><div class="sprev sp-other"><span class="sp-name">Other</span><span class="quiet-text">' + pv.other.count + (pv.other.count === 1 ? ' project' : ' projects') + '</span>'
      + '<span class="num sp-cost">' + esc(estMoney(pv.other.costMicros)) + '</span></div></li>');
  }
  return head + '<ul class="splist">' + items.join('') + '</ul>';
}

/** Costliest turns, metadata only. opts: { limit, compact } (compact is the Overview preview). */
function turnsTableHtml(rows, opts) {
  const o = opts || {};
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').slice(0, o.limit > 0 ? o.limit : 10);
  if (!list.length) return '<p class="empty-note">No turns recorded this month</p>';
  const body = list.map((r, i) => '<tr>' + (o.compact ? '' : '<td class="rank">' + String(i + 1).padStart(2, '0') + '</td>')
    + '<td class="num">' + esc(formatTime(r.ts)) + '</td>'
    + '<td>' + esc(projectLabel(r.project)) + '</td>'
    + (o.compact ? '' : '<td class="mono">' + esc(r.sessionShort) + '</td>')
    + '<td class="num">' + esc(estMoney(r.costMicros)) + '</td>'
    + '<td>' + modelsHtml(r.models) + '</td>'
    + (o.compact ? '' : '<td>' + esc(ATTR_LABEL[r.attribution] || 'Unattributed') + '</td>') + '</tr>').join('');
  const head = o.compact
    ? '<tr><th>Time</th><th>Project</th><th>Cost</th><th>Model</th></tr>'
    : '<tr><th>#</th><th>Time</th><th>Project</th><th>Session</th><th>Estimated cost</th><th>Model</th><th>Attribution</th></tr>';
  return '<div class="table-wrap"><table class="turns' + (o.compact ? ' turns-compact' : '') + '"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

/** The Projects table (project x source, 14-day trend, Other roll-up, total); q filters named projects. */
function projectsTableHtml(where, q, sel) {
  const rows = spendRows(where);
  const qn = String(q == null ? '' : q).trim().toLowerCase();
  const shown = qn ? rows.filter((r) => projectLabel(r.project).toLowerCase().indexOf(qn) >= 0) : rows;
  const o = where && where.other && typeof where.other === 'object' ? where.other : null;
  const showOther = !qn && o && (Number(o.count) > 0 || nz(o.costMicros) > 0);
  if (!shown.length && !showOther) {
    return '<p class="empty-note">' + (qn ? 'No project matches “' + esc(String(q).trim().slice(0, 80)) + '”' : 'No project spend this month') + '</p>';
  }
  const money = (x) => '<td class="num">' + esc(estMoney(x)) + '</td>';
  const cells = (r) => money((r.bySource || {}).main) + money((r.bySource || {}).subagent) + money((r.bySource || {}).auxiliary)
    + '<td><strong class="num">' + esc(estMoney(r.costMicros)) + '</strong></td><td class="num">n=' + Math.floor(nz(r.requests)) + '</td><td>' + sparkSvg(r.trend) + '</td>';
  let body = shown.map((r) => {
    const named = typeof r.project === 'string' && r.project !== '';
    const on = named && r.project === sel;
    return '<tr class="srow' + (on ? ' sel' : '') + (named ? '' : ' nosel') + '"' + (named ? ' tabindex="0" data-ssel="' + esc(r.project) + '"' + (on ? ' aria-current="true"' : '') : '') + '>'
      + '<td class="proj">' + esc(projectLabel(r.project)) + '</td>' + cells(r) + '</tr>';
  }).join('');
  if (showOther) {
    body += '<tr class="sother"><td class="proj">Other projects <span class="quiet-text">(' + Math.floor(nz(o.count)) + ')</span></td>' + cells(o) + '</tr>';
  }
  const tot = where && where.total ? where.total : {};
  const foot = !qn ? '<tfoot><tr><td class="proj">Total</td><td></td><td></td><td></td><td><strong class="num">' + esc(estMoney(tot.costMicros)) + '</strong></td><td class="num">n=' + Math.floor(nz(tot.requests)) + '</td><td></td></tr></tfoot>' : '';
  return '<div class="table-wrap"><table class="stable"><thead><tr><th>Project</th><th>Main</th><th>Subagent</th><th>Auxiliary</th><th>Total</th><th>Requests</th><th>14 days</th></tr></thead>'
    + '<tbody>' + body + '</tbody>' + foot + '</table></div>';
}

/** One window of cache figures: a bar of read / creation / uncached input, with token counts and the read share (n requests). */
function cacheCardHtml(label, b) {
  const head = '<h3>' + esc(label) + '</h3>';
  if (!b || typeof b !== 'object' || b.enabled === false) return '<section class="ccard">' + head + '<p class="empty-note">Not available right now</p></section>';
  const read = nz(b.cacheReadTokens), creation = nz(b.cacheCreationTokens), input = nz(b.inputTokens);
  const n = Math.floor(nz(b.requests));
  const sub = '<span class="sub num">n=' + n + (n === 1 ? ' request' : ' requests') + '</span>';
  if (read + creation + input <= 0) return '<section class="ccard"><div class="chead">' + head + sub + '</div><p class="empty-note">No input-side tokens in this window</p></section>';
  const p = largestRemainder([read, creation, input]);
  const share = b.cacheReadSharePct == null || !Number.isFinite(Number(b.cacheReadSharePct)) ? 'No share' : Number(b.cacheReadSharePct).toFixed(1) + '% read';
  const aria = 'Cache read ' + p[0] + '%, cache creation ' + p[1] + '%, uncached input ' + p[2] + '% of input-side tokens, n=' + n;
  const line = (cls, name, tok, pct) => '<li><i class="swatch ' + cls + '"></i><span>' + esc(name) + '</span><span class="num">' + esc(fmtTokens(tok)) + ' tokens</span><span class="num quiet-text">' + pct + '% (n=' + n + ')</span></li>';
  return '<section class="ccard"><div class="chead">' + head + sub + '</div>'
    + '<div class="cshare num">' + esc(share) + '</div>'
    + '<div class="cbar" role="img" aria-label="' + esc(aria) + '"><span class="cseg-read" data-w="' + p[0] + '"></span><span class="cseg-creation" data-w="' + p[1] + '"></span><span class="cseg-input" data-w="' + p[2] + '"></span></div>'
    + '<ul class="clist">' + line('cseg-read', 'Cache read', read, p[0]) + line('cseg-creation', 'Cache creation', creation, p[1]) + line('cseg-input', 'Uncached input', input, p[2]) + '</ul></section>';
}

function spendCacheHtml(caches) {
  const c = caches && typeof caches === 'object' ? caches : {};
  return '<div class="section-top"><h2>Cache<span class="sub">Token counts from the local ledger</span></h2></div>'
    + '<div class="cgrid">' + CACHE_WINDOWS.map((w) => cacheCardHtml(w[1], c[w[0]])).join('') + '</div>'
    + '<p class="quiet-text cnote">Read share is cache read over all input-side tokens (read, creation and uncached input). Token counts only; Sereno shows no savings figure.</p>';
}

/** Right column, selected project: month-to-date total, source bars, attribution mix with n, 14-day trend, View project. */
function spendSideHtml(sel, ctx) {
  if (typeof sel !== 'string' || sel === '') return '';
  const c = ctx || {};
  const d = c.detail && typeof c.detail === 'object' ? c.detail : null;
  const row = c.row && typeof c.row === 'object' ? c.row : null;
  const src = (d && d.bySource) || (row && row.bySource) || {};
  const cost = d ? nz(d.costMicros) : nz(row && row.costMicros);
  const trend = (d && Array.isArray(d.trend) ? d.trend : null) || (row && Array.isArray(row.trend) ? row.trend : []);
  const link = typeof c.link === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.link)
    ? '<a class="btn-copy sview" href="#projects/' + esc(c.link) + '">View project</a>' : '';
  const bars = [['main', nz(src.main)], ['subagent', nz(src.subagent)], ['auxiliary', nz(src.auxiliary)]].map(([k, v]) => {
    const w = cost > 0 ? Math.min(100, Math.round((v / cost) * 100)) : 0;
    return '<li><span class="sb-k"><i class="swatch seg-' + k + '"></i>' + esc(SRC_LABEL[k]) + '</span><span class="num sb-v">' + esc(estMoney(v)) + '</span>'
      + '<span class="sb-bar"><span class="seg-' + k + '" data-w="' + w + '"></span></span></li>';
  }).join('');
  let attr = '<p class="quiet-text">Attribution is not available right now.</p>';
  if (d) {
    const n = Math.floor(nz(d.requests));
    if (n === 0) attr = '<p class="quiet-text">No requests this month (n=0)</p>';
    else {
      const a = attributionSplit(d.byAttribution, d.requests);
      const nn = d.byAttributionN || {};
      attr = '<div class="attr-bar2" role="img" aria-label="' + esc(a.explicitPct + '% explicit, ' + a.unattributedPct + '% unattributed, n=' + a.n) + '"><span class="seg-main" data-w="' + a.explicitPct + '"></span>'
        + '<span class="seg-unattributed" data-w="' + a.unattributedPct + '"></span></div>'
        + '<ul class="sattr"><li><i class="swatch seg-main"></i>Explicit <span class="num">' + a.explicitPct + '% (n=' + Math.floor(nz(nn.explicit)) + ')</span></li>'
        + '<li><i class="swatch seg-unattributed"></i>Unattributed <span class="num">' + a.unattributedPct + '% (n=' + Math.floor(nz(nn.unknown)) + ')</span></li></ul>';
    }
  }
  const t14 = trend.reduce((s, x) => s + nz(x), 0);
  return '<section class="ppanel spanel" aria-label="Selected project"><div class="ppanel-head"><h2>' + esc(sel) + '</h2>' + link + '</div>'
    + '<div class="ppanel-sub">Month to date</div><div class="stotal num">' + esc(estMoney(cost)) + '</div>'
    + '<h4>By source</h4><ul class="sbars">' + bars + '</ul>'
    + '<h4>Attribution</h4>' + attr
    + '<h4>Last 14 days</h4><div class="strend">' + sparkSvg(trend) + '<span class="num quiet-text">' + esc(estMoney(t14)) + '</span></div></section>';
}

/**
 * The right column on the Spend tab: the pinned attention block (a decision, or a stalled note) and the
 * selected-project panel. Same live / non-live split as the Pipeline tab. ctx: { nowMs, opts }.
 */
function spendSideParts(st, panelMarkup, ctx) {
  const c = ctx || {};
  const pinned = st && !st.unavailable && (st.amber || (Array.isArray(st.stalled) && st.stalled.length)) ? attentionHtml(st, c.nowMs, c.opts) : '';
  const panel = typeof panelMarkup === 'string' ? panelMarkup : '';
  return pinned || panel ? { attn: pinned, panel } : { attn: attentionHtml(st || { amber: false, count: 0, items: [] }, c.nowMs, c.opts), panel: '' };
}

/** The whole page body for one sub-tab. d: { ov, series, where, top, caches }; ui: { sub, sel, range, q, pill }. */
function spendPageHtml(d, ui) {
  const data = d || {};
  const u = ui || {};
  const sub = SPEND_SUBS.indexOf(u.sub) >= 0 ? u.sub : 'overview';
  let body;
  if (sub === 'projects') {
    body = '<div class="section-top"><h2>Where the spend goes<span class="sub">Month to date</span></h2>'
      + '<input type="search" class="nsearch ssearch" data-sq maxlength="80" placeholder="Search projects" aria-label="Search projects" value="' + esc(u.q || '') + '"></div>'
      + '<div id="sproj-body">' + projectsTableHtml(data.where, u.q, u.sel) + '</div>';
  } else if (sub === 'turns') {
    body = '<div class="section-top"><h2>Costliest turns<span class="sub">Month to date</span></h2><span class="sub">Metadata only. Prompt text is never stored.</span></div>'
      + turnsTableHtml(data.top && data.top.rows, { limit: 10 });
  } else if (sub === 'cache') {
    body = spendCacheHtml(data.caches);
  } else {
    body = chartBlock(u.range) + '<div class="sgrid"><section class="scol" aria-label="Where the spend goes">' + wherePreviewHtml(data.where, u.sel) + '</section>'
      + '<section class="scol" aria-label="Costliest turns"><div class="section-top"><h2>Costliest turns<span class="sub">Month to date</span></h2>'
      + '<a class="sall" href="' + esc(spendHash('turns', u.sel)) + '">All turns</a></div>'
      + turnsTableHtml(data.top && data.top.rows, { limit: 3, compact: true }) + '</section></div>';
  }
  return spendHeaderHtml(data.ov, u.pill) + spendTabsHtml(sub, u.sel) + '<div class="sbody">' + body + '</div>';
}

/* ---------- state ---------- */

const RANGES = ['24h', '7d', '30d'];
const SRC_LABEL = { main: 'Main', subagent: 'Subagent', auxiliary: 'Auxiliary', unattributed: 'Unattributed' };
const ATTR_LABEL = { explicit: 'Explicit', unknown: 'Unattributed', mixed: 'Mixed' };

const state = {
  range: '30d', today: null, series: null,
  spend: { sub: 'overview', sel: null, q: '', ov: null, where: null, top: null, caches: null, detail: null, detailFor: null, token: 0 },
  mode: 'loading', lastOk: null, token: 0,
  attn: null, attnToken: 0,   // attn: attentionState() output, { unavailable: true }, or null before the first read
  route: 'projects',
  proj: { mode: 'loading', list: [], counts: null, filter: 'active', q: '', sort: 'pinned', open: { inactive: false }, tab: 'branches', managing: false, sel: null, pluginMissing: false, token: 0, lastOk: null },
  pipe: { mode: 'loading', body: null, token: 0, lastOk: null, sub: 'work', project: 'all', stage: 'all', sel: null, open: { idle: false, quiet: false } },
  sessions: [],               // /state sessions, for the Projects summary, filters and live strip
  liveMap: {}, liveSig: '', seenIds: new Set(),   // client-side live states from the SSE stream
  apiToken: null, reviewNA: false, reviewMsgs: {},
};

const TABS = { projects: 'Projects', spend: 'Spend', pipeline: 'Pipeline' };

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
  const padL = 46, padR = 6, padT = 22, padB = 22, plotH = 150;
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

function chartBlock(range) {
  const toggle = RANGES.map((r) => '<button type="button" data-range="' + r + '" class="' + (r === range ? 'on' : '')
    + '" aria-pressed="' + (r === range) + '">' + r + '</button>').join('');
  const t = chartTitle(range);
  return '<section class="schart" aria-label="Usage by source"><div class="section-top"><h2><span id="chart-title">' + t.title + '</span><span class="sub" id="chart-sub">' + t.sub + '</span></h2>'
    + '<div class="legend">' + legendHtml() + '</div><div class="range" role="group" aria-label="Range">' + toggle + '</div></div>'
    + '<div class="chart-box" id="chart-box"></div></section>';
}

function drawChart() {
  const box = document.getElementById('chart-box');
  if (!box || !state.series) return;
  setHtml(box, chartSvg(state.series, box.clientWidth));
}

function titleRow() {
  return '<div class="title-row"><h1>Spend</h1><span id="pill-slot">' + pillHtml(state.attn && state.attn.amber ? state.attn.count : 0) + '</span></div>';
}

function renderAttention() {
  const box = document.getElementById('attn-live');
  const ptask = document.getElementById('ptask');
  if (box) {
    const opts = { review: true, na: state.reviewNA, msgs: state.reviewMsgs };
    if (state.route === 'pipeline') {
      const parts = pipelineSideParts(state.attn, state.pipe.mode === 'data' ? state.pipe.body : null, pipeUiOf(), { sessions: state.sessions, projectsList: state.proj.list, opts, nowMs: Date.now() });
      setHtml(box, parts.attn);
      if (ptask) setHtml(ptask, parts.panel);
    } else if (state.route === 'spend') {
      const parts = spendSideParts(state.attn, spendPanelNow(), { opts, nowMs: Date.now() });
      setHtml(box, parts.attn);
      if (ptask) { setHtml(ptask, parts.panel); applyWidths(ptask); }
    } else {
      setHtml(box, attentionHtml(state.attn || { amber: false, count: 0, items: [] }, Date.now(), opts));
      if (ptask) setHtml(ptask, '');
    }
  }
  const slot = document.getElementById('pill-slot');
  if (slot && state.route !== 'pipeline') setHtml(slot, pillHtml(state.attn && state.attn.amber ? state.attn.count : 0));   // the Pipeline pill counts decisions only
}

function panel(title, text) {
  return titleRow() + '<div class="state-panel"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
}

/** The selected-project panel for the right column, from what the page already holds. '' when there is nothing to show. */
function spendPanelNow() {
  if (state.mode !== 'data') return '';
  const sp = state.spend;
  if (noSpendYet(state.today, state.series, sp.where)) return '';
  const sel = spendResolveSel(sp.where, sp.sel);
  if (!sel) return '';
  return spendSideHtml(sel, {
    row: spendRows(sp.where).find((r) => r.project === sel) || null,
    detail: sp.detailFor === sel ? sp.detail : null,
    link: projectIdFor(state.proj.list, sel),
  });
}

/** The element that holds focus (a project row or the search box), as a way to find its twin after a re-render. */
function spendFocusKey(view) {
  const ae = document.activeElement;
  if (!ae || !ae.getAttribute || !view.contains(ae)) return null;
  if (ae.getAttribute('data-ssel') !== null) return ['data-ssel', ae.getAttribute('data-ssel')];
  if (ae.getAttribute('data-sq') !== null) return ['data-sq', ''];
  return null;
}

function spendRestoreFocus(view, key) {
  if (!key) return;
  const el = Array.from(view.querySelectorAll('[' + key[0] + ']')).find((x) => key[0] === 'data-sq' || x.getAttribute('data-ssel') === key[1]);
  if (!el) return;
  el.focus();
  if (key[0] === 'data-sq' && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) { /* not a text input */ } }
}

function render() {
  if (state.route !== 'spend') return;
  const view = document.getElementById('view');
  const side = document.getElementById('side-today');
  view.setAttribute('aria-busy', state.mode === 'loading' ? 'true' : 'false');
  if (state.mode === 'loading') { setHtml(view, ''); setHtml(side, ''); renderAttention(); return; }
  if (state.mode === 'off') {
    setHtml(side, '');
    setHtml(view, panel('Spend history is off', 'Turn it on from the Sereno tray: Keep spend history.'));
    renderAttention();
    return;
  }
  if (state.mode === 'unavailable') {
    setHtml(side, '');
    setHtml(view, panel('Spend history is unavailable right now', 'Sereno will try again on the next refresh.'));
    renderAttention();
    return;
  }
  const sp = state.spend;
  setHtml(side, esc(estMoney(state.today.costMicros)) + ' today');
  if (noSpendYet(state.today, state.series, sp.where)) {
    setHtml(view, panel('No spend recorded yet', 'Spend appears once Claude Code sessions send telemetry. Wire it from the tray: Wire telemetry…'));
    renderAttention();
    return;
  }
  const key = spendFocusKey(view);
  setHtml(view, spendPageHtml({ ov: sp.ov, series: state.series, where: sp.where, top: sp.top, caches: sp.caches },
    { sub: sp.sub, sel: spendResolveSel(sp.where, sp.sel), range: state.range, q: sp.q, pill: state.attn && state.attn.amber ? state.attn.count : 0 }));
  applyWidths(view);
  drawChart();
  spendRestoreFocus(view, key);
  renderAttention();
}

/** Select a project on the Spend tab: keep it in the hash without adding history entries, then load its detail. */
function selectSpendProject(name, focus) {
  state.spend.sel = name;
  try { history.replaceState(null, '', spendHash(state.spend.sub, name)); } catch (_) { /* file:// or sandboxed: the route just stays */ }
  render();
  if (focus) {
    const on = Array.from(document.querySelectorAll('tr.srow')).find((x) => x.getAttribute('data-ssel') === name);
    if (on) on.focus();
  }
  refreshSpendDetail();
}

/** Re-render only the Projects table (typing in the search box must not move focus). */
function renderSpendTable() {
  const box = document.getElementById('sproj-body');
  if (box) setHtml(box, projectsTableHtml(state.spend.where, state.spend.q, spendResolveSel(state.spend.where, state.spend.sel)));
}

/* ---------- Projects tab: rendering ---------- */

function projectsTitle() {
  const calm = state.attn && !state.attn.unavailable ? '<span class="nav-calm">Nothing needs you</span>' : '';
  return '<div class="title-row"><h1>Projects</h1><div class="title-right"><span id="pill-slot">' + pillHtml(state.attn && state.attn.amber ? state.attn.count : 0) + '</span>' + calm
    + '<button type="button" class="btn-copy" data-act="manage" aria-pressed="' + (state.proj.managing === true) + '">' + (state.proj.managing ? 'Done' : 'Manage projects') + '</button></div></div>';
}

/** The navigator's input: the current list with live states, the UI state and the session list. */
function navCtx() {
  const p = state.proj;
  return { projects: withLive(p.list, state.liveMap), counts: p.counts, sessions: state.sessions, nowMs: Date.now(), sel: p.sel, pluginMissing: p.pluginMissing,
    ui: { filter: p.filter, q: p.q, sort: p.sort, open: p.open, tab: p.tab, managing: p.managing }, opts: { review: true, na: state.reviewNA, msgs: state.reviewMsgs } };
}

/** The element that holds focus, as a way to find its twin after a re-render. */
function focusKey(view) {
  const ae = document.activeElement;
  if (!ae || !ae.getAttribute || !view.contains(ae)) return null;
  for (const a of ['data-nq', 'data-nsort', 'data-nsel', 'data-ntab', 'data-filter']) if (ae.getAttribute(a) !== null) return [a, ae.getAttribute(a)];
  if (ae.getAttribute('data-act') === 'pin') return ['pin', ae.getAttribute('data-id')];
  return null;
}

function restoreFocus(view, key) {
  if (!key) return;
  const sel = key[0] === 'pin' ? '[data-act="pin"]' : '[' + key[0] + ']';
  const el = Array.from(view.querySelectorAll(sel)).find((x) => key[0] === 'data-nq' || key[0] === 'data-nsort' || x.getAttribute(key[0] === 'pin' ? 'data-id' : key[0]) === key[1]);
  if (!el) return;
  el.focus();
  if (key[0] === 'data-nq' && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) { /* not a text input */ } }
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
  const key = focusKey(view);
  setHtml(view, projectsTitle() + navPage(navCtx()));
  restoreFocus(view, key);
}

/** The list and the detail pane only: typing in the search box, or moving the selection, leaves the controls (and their focus) alone. */
function renderNavPanes() {
  if (state.route !== 'projects' || state.proj.mode !== 'data') return;
  const list = document.getElementById('nlist');
  const detail = document.getElementById('ndetail');
  if (!list || !detail || state.proj.managing) { renderProjects(); return; }
  const c = navCtx();
  const sel = navResolveSel(c.projects, c.sel);
  const o = { filter: c.ui.filter, q: c.ui.q, sort: c.ui.sort, open: c.ui.open, sel, nowMs: c.nowMs };
  setHtml(list, navListHtml(c.projects, o));
  const p = c.projects.find((x) => x && x.id === sel && x.hidden !== true) || null;
  setHtml(detail, navDetailHtml(p, { nowMs: c.nowMs, sid: p ? liveSessionId(p.id, c.projects, c.sessions) : null, opts: c.opts, tab: c.ui.tab, pluginMissing: c.pluginMissing, sessions: c.sessions }));
}

function focusNavRow(view, id) {
  const on = Array.from(view.querySelectorAll('.nrow')).find((x) => x.getAttribute('data-nsel') === id);
  if (on) on.focus();
}

/** Select a project: keep it in the route (#projects/<id>) without adding history entries. */
function selectProject(id) {
  state.proj.sel = id;
  try { history.replaceState(null, '', '#projects/' + encodeURIComponent(id)); } catch (_) { /* file:// or sandboxed: the route just stays */ }
}

function pipelineTitle() {
  const c = state.pipe.body ? pipelineCounts(state.pipe.body) : { decisions: 0 };
  return '<div class="title-row"><h1>Pipeline</h1><span id="pill-slot">' + pillHtml(c.decisions) + '</span></div>';
}

function pipeUiOf() {
  const p = state.pipe;
  return pipeUi({ sub: p.sub, project: p.project, stage: p.stage, sel: p.sel, open: p.open }, p.mode === 'data' ? p.body : null);
}

function renderPipeline() {
  if (state.route !== 'pipeline') return;
  const view = document.getElementById('view');
  const p = state.pipe;
  view.setAttribute('aria-busy', p.mode === 'loading' ? 'true' : 'false');
  if (p.mode === 'loading') { setHtml(view, ''); renderAttention(); return; }
  if (p.mode === 'unavailable') { setHtml(view, pipelineTitle() + pipelineBody(null, [], pipeUiOf(), Date.now())); renderAttention(); return; }
  const ae = document.activeElement;
  const keep = ae && ae.getAttribute && view.contains(ae) ? (ae.getAttribute('data-sel') !== null ? '.prow[data-sel]' : ae.getAttribute('data-pf') !== null ? 'select[data-pf="' + ae.getAttribute('data-pf') + '"]' : '') : '';
  setHtml(view, pipelineTitle() + pipelineBody(p.body, state.proj.list, pipeUiOf(), Date.now()));
  if (keep) { const el = keep.indexOf('.prow') === 0 ? view.querySelector('.prow.sel') : view.querySelector(keep); if (el) el.focus(); }   // a refresh must not drop keyboard focus
  renderAttention();
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

async function refreshPipeline() {
  const p = state.pipe;
  const token = ++p.token;
  const [r, pr] = await Promise.all([getJson('/api/pipeline'), getJson('/api/projects')]);
  if (token !== p.token) return;
  if (pr.body && Array.isArray(pr.body.projects)) state.proj.list = pr.body.projects;   // for the Scribe line
  if (!r.body || !Array.isArray(r.body.projects)) {
    if (p.mode !== 'data') p.mode = 'unavailable';   // keep the last good body on a blip
  } else {
    p.body = r.body; p.mode = 'data'; p.lastOk = Date.now();
  }
  renderPipeline();
  tickSync();
}

async function refreshProjects() {
  const p = state.proj;
  const token = ++p.token;
  const [r, pl] = await Promise.all([getJson('/api/projects'), getJson('/api/pipeline')]);
  if (token !== p.token) return;
  if (!r.body || !Array.isArray(r.body.projects)) {
    if (p.mode !== 'data') p.mode = 'unavailable';   // keep showing the last good list on a blip
  } else {
    p.list = r.body.projects; p.mode = 'data'; p.lastOk = Date.now();
    p.counts = r.body.counts && typeof r.body.counts === 'object' ? r.body.counts : null;
    p.pluginMissing = !!(pl.body && pl.body.plugin && pl.body.plugin.installed === false);
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
  if (state.route === 'projects') renderNavPanes();
}

/** Copy text to the clipboard; the button says Copied, or Select and copy when the browser refuses. */
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(String(text)); ok = true; } catch (_) { ok = false; }
  if (btn) { btn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
}

async function setHidden(id, hidden) {
  const status = await postAction('/api/projects/' + encodeURIComponent(id) + '/hide', { hidden });
  if (status === 204) refreshProjects();
}

async function setPinned(id, pinned) {
  const status = await postAction('/api/projects/' + encodeURIComponent(id) + '/pin', { pinned });
  if (status === 204) refreshProjects();
}

async function refresh() {
  refreshAttention();
  const token = ++state.token;
  const sp = state.spend;
  const wantCache = sp.sub === 'cache';
  const reqs = [
    getJson('/api/spend/today'),
    getJson('/api/spend/overview'),
    getJson('/api/spend/series?range=' + state.range),
    getJson('/api/spend/where?range=month'),
    getJson('/api/spend/top-prompts?range=month&limit=10'),
    getJson('/api/projects'),   // only to map a spend project name to its Projects id for "View project"
  ];
  if (wantCache) for (const w of CACHE_WINDOWS) reqs.push(getJson('/api/spend/cache?range=' + w[0]));
  const res = await Promise.all(reqs);
  if (token !== state.token) return;   // a newer refresh superseded this one
  const [today, ov, series, where, top, pl] = res;
  const bad = pageState([today, ov, series, where, top]);
  if (bad) { state.mode = bad; render(); return; }
  if (pl.body && Array.isArray(pl.body.projects)) state.proj.list = pl.body.projects;
  state.today = today.body; state.series = series.body;
  sp.ov = ov.body; sp.where = where.body; sp.top = top.body;
  if (wantCache) {
    sp.caches = {};
    CACHE_WINDOWS.forEach((w, i) => { sp.caches[w[0]] = res[6 + i].body; });
  }
  state.mode = 'data';
  state.lastOk = Date.now();
  render();
  tickSync();
  refreshSpendDetail();
}

/** The selected project's detail (month-to-date breakdown, attribution n, trend). A failure leaves the panel on the table row's figures. */
async function refreshSpendDetail() {
  const sp = state.spend;
  const name = spendResolveSel(sp.where, sp.sel);
  if (!name) { sp.detail = null; sp.detailFor = null; return; }
  const token = ++sp.token;
  const r = await getJson('/api/spend/project?name=' + encodeURIComponent(name));
  if (token !== sp.token || state.route !== 'spend') return;
  sp.detail = r.body && r.body.enabled === true ? r.body : null;
  sp.detailFor = name;
  renderAttention();
}

/** Refresh whatever the current tab shows. */
function refreshActive() {
  if (state.route === 'spend') refresh();
  else if (state.route === 'pipeline') { refreshAttention(); refreshPipeline(); }
  else { refreshAttention(); refreshProjects(); }
}

function applyRoute(route, first) {
  state.route = route;
  if (route === 'pipeline') state.pipe.sub = parsePipeSub(location.hash);
  if (route === 'projects') state.proj.sel = parseProjectSel(location.hash);
  if (route === 'spend') { const h = parseSpendHash(location.hash); state.spend.sub = h.sub; if (h.sel) state.spend.sel = h.sel; }
  const bodyEl = document.querySelector('.body');
  if (bodyEl) { bodyEl.classList.toggle('pipe', route === 'pipeline'); bodyEl.classList.toggle('mode-projects', route === 'projects'); bodyEl.classList.toggle('spend', route === 'spend'); }
  renderAttention();   // the right column differs per tab
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
    : route === 'pipeline'
      ? 'Sereno observes the pipeline; it never acts \u00b7 every dollar figure is an estimate'
      : 'Dollar figures are estimates \u00b7 nothing leaves this machine';
  if (!first) saveTab(route);
  const side = document.getElementById('side-today');
  if (side) setHtml(side, '');
  if (route === 'spend') { render(); refresh(); }
  else if (route === 'pipeline') { renderPipeline(); refreshActive(); }
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
  if (el) el.textContent = syncLabel(state.route === 'spend' ? state.lastOk : state.route === 'pipeline' ? state.pipe.lastOk : state.proj.lastOk, Date.now());
}

/* ---------- boot ---------- */

function boot() {
  loadRange();
  const host = document.getElementById('foot-host');
  if (host) host.textContent = location.host + '/console';
  const viewEl = document.getElementById('view');
  viewEl.addEventListener('change', (e) => {
    const ns = e.target && e.target.closest ? e.target.closest('select[data-nsort]') : null;
    if (ns) { state.proj.sort = NAV_SORTS.some((x) => x[0] === ns.value) ? ns.value : 'pinned'; renderProjects(); return; }
    const sel = e.target && e.target.closest ? e.target.closest('select[data-pf]') : null;
    if (!sel) return;
    state.pipe[sel.getAttribute('data-pf') === 'stage' ? 'stage' : 'project'] = sel.value;
    renderPipeline();
  });
  viewEl.addEventListener('toggle', (e) => {   // toggle does not bubble: capture it, so a refresh keeps disclosures open
    const d = e.target && e.target.closest ? e.target.closest('details.pidle') : null;
    if (d) state.pipe.open[d.querySelector('.quiet-list') ? 'quiet' : 'idle'] = d.open === true;
    const g = e.target && e.target.closest ? e.target.closest('details.ninactive') : null;
    if (g && !String(state.proj.q).trim()) state.proj.open.inactive = g.open === true;   // while searching the group is forced open: not the user's choice
  }, true);
  viewEl.addEventListener('input', (e) => {
    const sq = e.target && e.target.closest ? e.target.closest('input[data-sq]') : null;
    if (sq) { state.spend.q = sq.value.slice(0, 80); renderSpendTable(); return; }
    const q = e.target && e.target.closest ? e.target.closest('input[data-nq]') : null;
    if (!q) return;
    state.proj.q = q.value.slice(0, 80);
    renderNavPanes();
  });
  viewEl.addEventListener('keydown', (e) => {
    if (state.route === 'projects') {
      if (!(e.target && e.target.closest && e.target.closest('.nrow')) || state.proj.mode !== 'data') return;   // keys act only from the list
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('nrow')) {
        e.preventDefault();
        selectProject(e.target.getAttribute('data-nsel'));
        renderNavPanes();
        focusNavRow(viewEl, state.proj.sel);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const ids = Array.from(viewEl.querySelectorAll('.nrow')).map((x) => x.getAttribute('data-nsel'));
      const next = navMove(ids, navResolveSel(withLive(state.proj.list, state.liveMap), state.proj.sel), e.key);
      if (next === null) return;
      selectProject(next);
      renderNavPanes();
      focusNavRow(viewEl, next);
      return;
    }
    if (state.route === 'spend') {
      const row = e.target && e.target.closest ? e.target.closest('tr.srow[data-ssel]') : null;
      if (!row || state.mode !== 'data') return;   // keys act only from the project rows
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSpendProject(row.getAttribute('data-ssel'), true); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const ids = Array.from(viewEl.querySelectorAll('tr.srow[data-ssel]')).map((x) => x.getAttribute('data-ssel'));
      const next = navMove(ids, row.getAttribute('data-ssel'), e.key);
      if (next !== null) selectSpendProject(next, true);
      return;
    }
    if (state.route !== 'pipeline' || state.pipe.sub !== 'work' || state.pipe.mode !== 'data') return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!(e.target && e.target.closest && e.target.closest('.ptable'))) return;   // arrows move the selection only from the table
    e.preventDefault();
    const key = moveSel(pipeRows(state.pipe.body, pipeUiOf()), state.pipe.sel, e.key === 'ArrowUp' ? -1 : 1);
    if (key === null) return;
    state.pipe.sel = key;
    renderPipeline();
    const on = viewEl.querySelector('.prow.sel');
    if (on) on.focus();
  });
  viewEl.addEventListener('click', (e) => {
    const tgt = e.target && e.target.closest ? e.target : null;
    const rowEl = tgt ? tgt.closest('.prow[data-sel]') : null;
    if (rowEl) { state.pipe.sel = rowEl.getAttribute('data-sel'); renderPipeline(); return; }
    const act = tgt ? tgt.closest('button[data-act], button[data-filter]') : null;
    if (act) {
      const f = act.getAttribute('data-filter');
      const a = act.getAttribute('data-act');
      if (f) { state.proj.filter = f; renderProjects(); return; }
      if (a === 'manage') { state.proj.managing = !state.proj.managing; renderProjects(); return; }
      if (a === 'pin') { setPinned(act.getAttribute('data-id'), act.getAttribute('data-pinned') !== 'true'); return; }
      if (a === 'copy') { copyText(act.getAttribute('data-text'), act); return; }
      if (a === 'hide' || a === 'unhide') { setHidden(act.getAttribute('data-id'), a === 'hide'); return; }
    }
    const tb = tgt ? tgt.closest('button[data-ntab]') : null;
    if (tb) { state.proj.tab = tb.getAttribute('data-ntab'); renderNavPanes(); const again = Array.from(viewEl.querySelectorAll('[data-ntab]')).find((x) => x.getAttribute('data-ntab') === state.proj.tab); if (again) again.focus(); return; }
    const nr = tgt ? tgt.closest('.nrow[data-nsel]') : null;
    if (nr) { selectProject(nr.getAttribute('data-nsel')); renderNavPanes(); focusNavRow(viewEl, nr.getAttribute('data-nsel')); return; }
    const ss = tgt && state.route === 'spend' ? tgt.closest('[data-ssel]') : null;
    if (ss) { selectSpendProject(ss.getAttribute('data-ssel'), ss.tagName === 'TR'); return; }
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
    else if (r === 'pipeline') { state.pipe.sub = parsePipeSub(location.hash); renderPipeline(); }
    else if (r === 'projects') { state.proj.sel = parseProjectSel(location.hash); renderProjects(); }
    else if (r === 'spend') {
      const h = parseSpendHash(location.hash);
      const changed = h.sub !== state.spend.sub;
      state.spend.sub = h.sub;
      if (h.sel) state.spend.sel = h.sel;
      render();
      if (changed) refresh(); else refreshSpendDetail();
    }
  });
  window.addEventListener('focus', () => { if (state.route === 'projects') refreshProjects(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshActive(); });
  setInterval(() => { if (document.visibilityState === 'visible' && state.route === 'spend') refresh(); }, 60000);
  setInterval(() => { if (document.visibilityState === 'visible' && state.route === 'projects') refreshProjects(); }, 30000);
  setInterval(() => { if (document.visibilityState === 'visible' && state.route === 'pipeline') refreshPipeline(); }, 30000);
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
