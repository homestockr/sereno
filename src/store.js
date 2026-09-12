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
 *   3. There is no SubagentStart event, so subagent liveness is inferred from
 *      previously unseen agent_ids and cleared by SubagentStop.
 */

const STALE_MS = 5 * 60 * 1000;
const DROP_MS = 30 * 60 * 1000;

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
        _agents: new Set(),
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

    const agentId = payload.agent_id || null;

    // --- subagent bookkeeping: tagged events never touch top-level state ---
    if (agentId) {
      if (event === 'SubagentStop') s._agents.delete(agentId);
      else s._agents.add(agentId);
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
        if (payload.tool_use_id) s._pending.set(payload.tool_use_id, d);
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

      case 'Stop':
        this._setState(s, 'idle');
        break;

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
        if ((a.state === 'blocked') !== (b.state === 'blocked')) {
          return a.state === 'blocked' ? -1 : 1;
        }
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
    const active = sessions.filter(
      (s) => !s.stale && s.state !== 'blocked' && (s.state === 'running' || s.state === 'thinking' || s.state === 'compacting')
    );
    const quiet = sessions.filter((s) => s.state !== 'blocked' && (s.stale || s.state === 'idle'));

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
