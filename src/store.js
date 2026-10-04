'use strict';
/*
 * Live session state. In memory only - this is a view, not a history tool.
 *
 * Three rules here come from docs/payloads.md rather than the build spec, because
 * the real payloads contradicted it:
 *
 *   1. Subagent tool calls arrive under the PARENT's session_id, tagged with
 *      agent_id. Only untagged events may drive top-level state, or a subagent's
 *      Bash overwrites the parent row and its PostToolUse clears a blocked parent.
 *   2. Notification does not name the tool being requested. We derive it from the
 *      last PreToolUse with no matching PostToolUse.
 *   3. Current Claude Code (2.1.289) sends SubagentStart, but it is just the
 *      first tagged event for that agent_id, so it needs no case of its own.
 *      Older builds (2.1.270) send no SubagentStart at all, so liveness is
 *      still inferred from previously unseen agent_ids as the fallback.
 *      SubagentStop clears the entry. Subagents can also run in the background
 *      and outlive the parent's Stop; see the Stop case below.
 */

const STALE_MS = 5 * 60 * 1000;
const DROP_MS = 30 * 60 * 1000;

// Denied tools never produce a PostToolUse, so the pending map needs a ceiling.
const MAX_PENDING = 32;

// A missed SubagentStop would otherwise accumulate forever. The turn's own Stop
// prunes the map (to the background_tasks it reports, or entirely on older
// builds), so this only has to survive one runaway turn.
//
// It drops the STALEST entry, exactly like MAX_PENDING above, and for a sharper
// reason: the entries filling this map when the ceiling bites are the ghosts of
// subagents whose SubagentStop went missing. Rejecting the arrival instead would
// keep the ghosts and hide the live subagent - entrenching the very failure the
// ceiling exists to contain.
const MAX_AGENTS = 32;

// A tombstone for an agent_id that has stopped: agent_id -> when. The shim is
// fire-and-forget over one connection per hook, so a subagent's last
// PostToolUse can arrive AFTER its SubagentStop; without this the late event
// re-creates the entry and a dead subagent reappears with a freshly started
// clock.
//
// agent_ids are NOT unique over time: resuming a subagent starts a new run under
// the same ID (code.claude.com/docs/en/sub-agents), so a tombstone that lived
// forever would hide the resumed run. Tombstones are therefore time-bound, see
// STRAGGLER_MS.
const MAX_STOPPED = 64;

// How long a tombstone suppresses events for its agent_id. A straggler is a late
// hook from the fire-and-forget shim, which arrives within seconds; a resume
// comes later (a new prompt, a new turn). Inside the window an event is a
// straggler and is dropped; past it, the event is a new run of the same id.
const STRAGGLER_MS = 30 * 1000;

// Only this notification_type may turn a row red. An unknown type must not, or the
// HUD cries wolf on idle pings. Text match is the spec's defensive fallback.
const PERMISSION_TYPE = 'permission_prompt';
const PERMISSION_TEXT = /permission|approve|waiting/i;

function isPermissionNotification(p) {
  const t = p && p.notification_type;
  if (typeof t === 'string') return t === PERMISSION_TYPE;
  return PERMISSION_TEXT.test(String((p && p.message) || ''));
}

/**
 * Splits a tool call into its name and its subject, kept apart because the UI
 * needs them apart: "Bash · npm test" on a running row, and the bare command in
 * the alert's code block.
 */
function describeTool(name, input) {
  const i = input || {};
  const raw =
    i.command || i.file_path || i.path || i.pattern || i.url ||
    i.prompt || i.description || i.query || '';
  const arg = String(raw).replace(/\s+/g, ' ').trim();
  return { tool: name || '', arg };
}

/** Trims a long subject for a single-line row without mangling a short one. */
function shorten(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Drops the least recently active entry, to make room for a live one. */
function evictStalest(map) {
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of map) {
    if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; }
  }
  if (oldestKey !== null) map.delete(oldestKey);
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const norm = String(cwd).replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || norm;
}

class Store {
  constructor(onChange) {
    this.sessions = new Map();
    this.onChange = onChange || (() => {});
    this.onBlocked = () => {};   // set by main, fires once per blocked episode
  }

  _get(id, payload) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd: (payload && payload.cwd) || '',
        projectName: projectName(payload && payload.cwd),
        model: '',
        state: 'idle',
        stateTool: '',
        stateArg: '',
        stateSince: Date.now(),
        costUsd: null,
        contextPct: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        rateLimits: null,
        subagents: 0,
        pid: null,
        lastSeen: Date.now(),
        // internal bookkeeping, stripped from the snapshot
        _pending: new Map(),   // tool_use_id -> { tool, arg }
        _agents: new Map(),   // agent_id -> { type, tool, arg, since, lastSeen }
        _stopped: new Map(),   // agent_id -> stoppedAt (ms); bounded, survives Stop
        _blockedNotified: false,
      };
      this.sessions.set(id, s);
    }
    if (payload && payload.cwd && payload.cwd !== s.cwd) {
      s.cwd = payload.cwd;
      s.projectName = projectName(payload.cwd);
    }
    return s;
  }

  _setState(s, state, tool, arg) {
    if (s.state !== state) {
      s.state = state;
      s.stateSince = Date.now();
    }
    s.stateTool = tool || '';
    s.stateArg = arg || '';
    if (state !== 'blocked') s._blockedNotified = false;
  }

  applyHook(event, payload, meta) {
    if (!payload || !payload.session_id) return;
    const s = this._get(payload.session_id, payload);
    s.lastSeen = Date.now();

    // emit.js reports its parent pid, which is the claude process for this
    // session. Nothing in the payload itself identifies the process.
    if (meta && meta.ppid) s.pid = meta.ppid;

    // Ids are compared as strings everywhere (a number would never match the
    // string a background_tasks entry carries).
    const agentId = payload.agent_id == null || payload.agent_id === '' ? null : String(payload.agent_id);

    // --- subagent bookkeeping: tagged events never touch top-level state ---
    if (agentId) {
      if (event === 'SubagentStop') {
        s._agents.delete(agentId);
        // Re-set so the entry is the newest, keeping eviction oldest-first.
        s._stopped.delete(agentId);
        if (s._stopped.size >= MAX_STOPPED) s._stopped.delete(s._stopped.keys().next().value);
        s._stopped.set(agentId, Date.now());
      } else {
        if (event === 'SubagentStart') {
          // A start is never a straggler: it is a new run, even of an id that
          // stopped a moment ago (a resume). Begin from a clean entry. Trade-off:
          // a Start reordered after its own Stop would leave a ghost until the
          // next Stop with a list or the stale timer; the shim's 250 ms cap
          // makes that reorder implausible across a subagent's lifetime.
          s._stopped.delete(agentId);
          s._agents.delete(agentId);
        } else if (s._stopped.has(agentId)) {
          // Known limitation: if a SubagentStop is lost, a straggler arriving
          // after the Stop re-creates the entry and the row reads Running until
          // the next Stop that carries a list, or the 5-minute stale timer.
          if (Date.now() - s._stopped.get(agentId) < STRAGGLER_MS) {
            // A straggler from a subagent that has just stopped. Reviving it
            // here would show a dead agent with a clock starting from now.
            this.onChange();
            return;
          }
          // Old tombstone: this is a later run under the same id (a resume).
          s._stopped.delete(agentId);
        }
        // SubagentStart is simply the first tagged event (and is absent on
        // 2.1.270), so the first tagged event we see IS the start as far as we
        // can tell: that is what the elapsed time counts from.
        let a = s._agents.get(agentId);
        if (!a) {
          if (s._agents.size >= MAX_AGENTS) evictStalest(s._agents);
          a = { type: '', tool: '', arg: '', since: Date.now(), lastSeen: Date.now() };
          s._agents.set(agentId, a);
        }
        // agent_type rides along on every tagged event, but defensively: a
        // subagent with no type still has to render as something.
        if (payload.agent_type) a.type = String(payload.agent_type);
        a.lastSeen = Date.now();

        // PreToolUse says what it just started. PostToolUse says that finished,
        // and until the next PreToolUse it is reasoning rather than running, so
        // the tool is cleared rather than left claiming to still be going.
        if (event === 'PreToolUse') {
          const d = describeTool(payload.tool_name, payload.tool_input);
          a.tool = d.tool;
          a.arg = d.arg;
        } else if (event === 'PostToolUse') {
          a.tool = '';
          a.arg = '';
        }
      }
      s.subagents = s._agents.size;
      this.onChange();
      return;
    }

    switch (event) {
      case 'SessionStart':
        this._setState(s, 'idle');
        break;

      case 'UserPromptSubmit':
        this._setState(s, 'thinking');
        break;

      case 'PreToolUse': {
        const d = describeTool(payload.tool_name, payload.tool_input);
        if (payload.tool_use_id) {
          // A denied tool never produces a PostToolUse, so entries can pile up
          // within a single turn. Keep only the most recent few - all the
          // blocked detail ever needs is the last one.
          if (s._pending.size >= MAX_PENDING) {
            s._pending.delete(s._pending.keys().next().value);
          }
          s._pending.set(payload.tool_use_id, d);
        }
        this._setState(s, 'running', d.tool, d.arg);
        break;
      }

      case 'PostToolUse':
        if (payload.tool_use_id) s._pending.delete(payload.tool_use_id);
        this._setState(s, 'thinking');
        break;

      case 'Notification': {
        if (isPermissionNotification(payload)) {
          // Notification carries no tool name; the pending tool is the subject.
          const pending = [...s._pending.values()];
          const d = pending[pending.length - 1] || { tool: '', arg: '' };
          const wasBlocked = s.state === 'blocked';
          this._setState(s, 'blocked', d.tool, d.arg);
          if (!wasBlocked && !s._blockedNotified) {
            s._blockedNotified = true;
            try { this.onBlocked(this.publicSession(s)); } catch (_) {}
          }
        }
        break;
      }

      case 'Stop': {
        // The turn is over: nothing can still be pending. Without this, a denied
        // tool leaves entries that never expire.
        //
        // Subagents are another matter. Since 2.1.289 they can run in the
        // background and outlive the parent's Stop, which then carries
        // background_tasks (docs/payloads.md §6). When that list is present it
        // is authoritative: keep exactly the subagents it reports as running and
        // drop the rest (this is what clears a missed SubagentStop). Anything it
        // lists that we never saw is added, typed from agent_type, and its
        // tombstone dropped whatever its age: a resume starts a new run under
        // the same agent_id, possibly seconds after it stopped. The only stale
        // list ever captured rode on a SubagentStop payload, which is not read;
        // Stop's own list has always matched reality (docs/payloads.md §6).
        // If a stale list ever did revive a finished subagent, the ghost lasts
        // only until the next Stop: a finished background subagent reports back
        // as a <task-notification> turn whose Stop carries the updated list.
        //
        // With no list (2.1.270 and earlier) nothing can outlive the turn, so
        // _agents is cleared as before. _stopped is deliberately kept either
        // way: it is bounded by MAX_STOPPED and expires by itself, and a
        // background subagent's stragglers can arrive after a later Stop.
        s._pending.clear();
        if (Array.isArray(payload.background_tasks)) {
          const running = new Set();
          const types = new Map();
          for (const t of payload.background_tasks) {
            if (!t || t.type !== 'subagent' || t.status !== 'running') continue;
            // Only strings and finite numbers are ids; an object or boolean is
            // junk, not something to String() into a row.
            if (typeof t.id !== 'string' && !(typeof t.id === 'number' && Number.isFinite(t.id))) continue;
            const id = String(t.id);
            if (!id) continue;
            running.add(id);
            types.set(id, t.agent_type ? String(t.agent_type) : '');
          }
          for (const id of [...s._agents.keys()]) {
            if (!running.has(id)) s._agents.delete(id);
          }
          for (const id of running) {
            if (s._agents.has(id)) continue;
            // Listed as running at Stop time: that is current, even for an id
            // that stopped moments ago (a resume can reuse it within seconds).
            s._stopped.delete(id);
            if (s._agents.size >= MAX_AGENTS) evictStalest(s._agents);
            const now = Date.now();
            s._agents.set(id, { type: types.get(id), tool: '', arg: '', since: now, lastSeen: now });
          }
        } else {
          s._agents.clear();
        }
        s.subagents = s._agents.size;
        this._setState(s, 'idle');
        break;
      }

      case 'SubagentStop':
        // Untagged SubagentStop: nothing reliable to remove, leave state alone.
        break;

      case 'PreCompact':
        this._setState(s, 'compacting');
        break;

      case 'SessionEnd':
        this.sessions.delete(payload.session_id);
        this.onChange();
        return;
    }
    this.onChange();
  }

  applyStatus(payload, meta) {
    if (!payload || !payload.session_id) return;
    const s = this._get(payload.session_id, payload);
    s.lastSeen = Date.now();
    if (meta && meta.ppid) s.pid = meta.ppid;

    if (payload.model && payload.model.display_name) s.model = payload.model.display_name;
    if (payload.cost && typeof payload.cost.total_cost_usd === 'number') {
      s.costUsd = payload.cost.total_cost_usd;
    }
    const ctx = payload.context_window;
    if (ctx) {
      if (typeof ctx.used_percentage === 'number') s.contextPct = Math.round(ctx.used_percentage);
      const u = ctx.current_usage || {};
      s.tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreation: u.cache_creation_input_tokens || 0,
      };
    }
    if (payload.rate_limits) s.rateLimits = payload.rate_limits;

    // A statusline refresh is liveness only. It must never clear `blocked`.
    this.onChange();
  }

  publicSession(s) {
    const now = Date.now();
    const staleFor = now - s.lastSeen;
    return {
      id: s.id,
      projectName: s.projectName,
      cwd: s.cwd,
      model: s.model,
      state: s.state,
      stateTool: s.stateTool,
      stateArg: s.stateArg,
      stateArgShort: shorten(s.stateArg, 44),
      stateSince: s.stateSince,
      costUsd: s.costUsd,
      contextPct: s.contextPct,
      tokens: s.tokens,
      rateLimits: s.rateLimits,
      subagents: s.subagents,
      // Insertion order is already chronological - entries are added when first
      // seen and since is stamped then - so there is nothing to sort.
      subagentList: [...s._agents.entries()].map(([id, a]) => ({
        id,
        type: a.type || 'agent',
        tool: a.tool,
        // A bound on what crosses the wire, not a display width: the row is
        // user-resizable, so the visible truncation is the renderer's ellipsis.
        // Cutting to a guessed width here produced a second ellipsis on top.
        arg: shorten(a.arg, 120),
        since: a.since,
      })),
      pid: s.pid,
      lastSeen: s.lastSeen,
      stale: staleFor > STALE_MS,
      staleForMs: staleFor,
    };
  }

  /** Drops dead sessions. Returns true if anything was removed. */
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > DROP_MS) { this.sessions.delete(id); changed = true; }
    }
    return changed;
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .map((s) => this.publicSession(s))
      .sort((a, b) => {
        // Blocked first - it is the reason the widget exists.
        const aBlocked = a.state === 'blocked';
        const bBlocked = b.state === 'blocked';
        if (aBlocked !== bBlocked) return aBlocked ? -1 : 1;

        // Among blocked, longest wait first. This used to fall through to
        // lastSeen, which put the NEWEST block on top: the statusline stops
        // firing while a session is blocked, so lastSeen is roughly the moment
        // it blocked. The session that had been ignored longest therefore sank
        // down the list, and the alert block promoted the freshest one.
        if (aBlocked && bBlocked) return a.stateSince - b.stateSince;

        if (a.stale !== b.stale) return a.stale ? 1 : -1;
        return b.lastSeen - a.lastSeen;
      });

    let totalCost = 0;
    // The footer names a specific window, so the windows are kept apart rather
    // than collapsed into one "worst" number.
    const windows = {};
    for (const s of sessions) {
      if (typeof s.costUsd === 'number') totalCost += s.costUsd;
      if (!s.rateLimits) continue;
      for (const key of Object.keys(s.rateLimits)) {
        const v = s.rateLimits[key];
        if (!v || typeof v.used_percentage !== 'number') continue;
        const pct = Math.round(v.used_percentage);
        if (!windows[key] || pct > windows[key].usedPct) {
          windows[key] = { usedPct: pct, resetsAt: typeof v.resets_at === 'number' ? v.resets_at : null };
        }
      }
    }

    const blocked = sessions.filter((s) => s.state === 'blocked');
    // An idle session with live subagents is still working in the background,
    // so it counts as active, never quiet. The two filters are mutually
    // exclusive: active requires !stale, quiet requires stale or no background work.
    const isActive = (s) => !s.stale && s.state !== 'blocked' && (
      s.state === 'running' || s.state === 'thinking' || s.state === 'compacting' ||
      (s.state === 'idle' && s.subagents > 0)
    );
    const active = sessions.filter(isActive);
    const quiet = sessions.filter((s) => s.state !== 'blocked' && !isActive(s) && (s.stale || s.state === 'idle'));

    return {
      now: Date.now(),
      sessions,
      totalCost,
      windows,
      counts: { total: sessions.length, blocked: blocked.length, active: active.length, quiet: quiet.length },
    };
  }
}

module.exports = {
  Store, describeTool, isPermissionNotification, projectName, shorten, STALE_MS, DROP_MS,
};
