// @ts-check
'use strict';
/*
 * OTLP/JSON -> normalized records. Pure: no I/O, never throws.
 *
 * ALLOWLIST: only the attribute keys named in LOG_KEYS / SPAN_KEYS are ever
 * read. Everything else on the wire (user.email, user.id, user.account_id,
 * user.account_uuid, organization.id, terminal.type, prompts, ...) never
 * leaves this module.
 *
 * Absent values: ids/strings are null, numbers (tokens, cost, duration, ts)
 * are 0. Numbers are always finite integers, never NaN.
 *
 * Key names follow docs/payloads.md section 6: `agent.name` (dotted),
 * `query_source`, `request_id`, `cost_usd_micros`. The doc is silent on the
 * token/duration/sequence/session/prompt keys; those use Claude Code's
 * documented names (input_tokens, output_tokens, cache_read_tokens,
 * cache_creation_tokens, duration_ms, event.sequence, session.id, prompt.id).
 */

/**
 * @typedef {'main'|'subagent'|'auxiliary'} Source
 * @typedef {Object} RequestRecord
 * @property {string} requestKey
 * @property {string|null} requestId
 * @property {string|null} sessionId
 * @property {string|null} promptId
 * @property {number} ts            ms since epoch, 0 if unknown
 * @property {string|null} model
 * @property {string|null} querySource
 * @property {Source} source
 * @property {string|null} agentName
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} costMicros    integer micro-dollars
 * @property {number} durationMs
 * @typedef {Object} SpanRecord
 * @property {string|null} requestId
 * @property {string|null} sessionId
 * @property {string|null} agentId  null for main-thread spans
 * @property {number} ts
 */

const LOG_KEYS = new Set([
  'event.name', 'event.timestamp', 'event.sequence', 'request_id', 'session.id',
  'prompt.id', 'model', 'query_source', 'agent.name', 'input_tokens',
  'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  'cost_usd_micros', 'cost_usd', 'duration_ms',
]);
const SPAN_KEYS = new Set(['span.type', 'request_id', 'session.id', 'agent_id']);

/** @param {any} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Decode one OTLP AnyValue to string|number|undefined. @param {any} v */
function anyValue(v) {
  if (!isObj(v)) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.intValue === 'number' || typeof v.intValue === 'string') {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v.doubleValue === 'number' || typeof v.doubleValue === 'string') {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Read allowlisted attributes from a KeyValue list into `into`.
 * Returns false if the list is present but not an array (garbled).
 * @param {any} list @param {Set<string>} allow @param {Map<string,string|number>} into
 */
function readAttrs(list, allow, into) {
  if (list === undefined || list === null) return true;
  if (!Array.isArray(list)) return false;
  for (const kv of list) {
    if (!isObj(kv) || typeof kv.key !== 'string' || !allow.has(kv.key)) continue;
    const v = anyValue(kv.value);
    if (v !== undefined) into.set(kv.key, v);
  }
  return true;
}

/** @param {Map<string,string|number>} m @param {string} k @returns {string|null} */
function str(m, k) {
  const v = m.get(k);
  if (v === undefined || v === '') return null;
  return String(v);
}
/** @param {Map<string,string|number>} m @param {string} k */
function int(m, k) {
  const v = m.get(k);
  if (v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** @param {any} nano @param {any} fallback */
function toMs(nano, fallback) {
  if (typeof nano === 'string' || typeof nano === 'number') {
    const n = Number(nano);
    if (Number.isFinite(n) && n > 0) return Math.floor(n / 1e6);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return Math.round(fallback);
  if (typeof fallback === 'string' && fallback !== '') {
    const n = Number(fallback);
    if (Number.isFinite(n)) return Math.round(n);
    const d = Date.parse(fallback);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/** @param {string|null} qs @returns {Source} */
function classify(qs) {
  if (qs === 'repl_main_thread') return 'main';
  if (qs !== null && qs.startsWith('agent:')) return 'subagent';
  return 'auxiliary';
}

/**
 * @param {any} body @param {string} l1 @param {string} l2 @param {string} l3
 * @param {Set<string>} allow
 * @param {(res: Map<string,string|number>, item: any) => void} fn
 */
function walk(body, l1, l2, l3, allow, fn) {
  if (!isObj(body) || !Array.isArray(body[l1])) return;
  for (const r of body[l1]) {
    if (!isObj(r) || !Array.isArray(r[l2])) continue;
    const res = new Map();
    if (!readAttrs(isObj(r.resource) ? r.resource.attributes : undefined, allow, res)) continue;
    for (const s of r[l2]) {
      if (!isObj(s) || !Array.isArray(s[l3])) continue;
      for (const item of s[l3]) {
        try { fn(res, item); } catch { /* skip the bad record */ }
      }
    }
  }
}

/**
 * @param {any} body OTLP/JSON logs export
 * @returns {RequestRecord[]}
 */
function parseLogs(body) {
  /** @type {RequestRecord[]} */
  const out = [];
  try {
    walk(body, 'resourceLogs', 'scopeLogs', 'logRecords', LOG_KEYS, (res, rec) => {
      if (!isObj(rec)) return;
      const a = new Map(res);
      if (!readAttrs(rec.attributes, LOG_KEYS, a)) return;
      if (a.get('event.name') !== 'api_request') return;
      const requestId = str(a, 'request_id');
      const sessionId = str(a, 'session.id');
      let requestKey = requestId;
      if (requestKey === null) {
        const seq = str(a, 'event.sequence');
        if (sessionId === null || seq === null) return;
        requestKey = sessionId + ':' + seq;
      }
      const querySource = str(a, 'query_source');
      const um = Number(a.get('cost_usd_micros'));
      const usd = Number(a.get('cost_usd'));
      const costMicros = a.has('cost_usd_micros') && Number.isFinite(um) ? Math.round(um)
        : (a.has('cost_usd') && Number.isFinite(usd) ? Math.round(usd * 1e6) : 0);
      out.push({
        requestKey, requestId, sessionId,
        promptId: str(a, 'prompt.id'),
        ts: toMs(rec.timeUnixNano, a.get('event.timestamp')),
        model: str(a, 'model'),
        querySource,
        source: classify(querySource),
        agentName: str(a, 'agent.name'),
        inputTokens: int(a, 'input_tokens'),
        outputTokens: int(a, 'output_tokens'),
        cacheReadTokens: int(a, 'cache_read_tokens'),
        cacheCreationTokens: int(a, 'cache_creation_tokens'),
        costMicros,
        durationMs: int(a, 'duration_ms'),
      });
    });
  } catch { return []; }
  return out;
}

/**
 * @param {any} body OTLP/JSON traces export
 * @returns {SpanRecord[]}
 */
function parseTraces(body) {
  /** @type {SpanRecord[]} */
  const out = [];
  try {
    walk(body, 'resourceSpans', 'scopeSpans', 'spans', SPAN_KEYS, (res, span) => {
      if (!isObj(span)) return;
      const a = new Map(res);
      if (!readAttrs(span.attributes, SPAN_KEYS, a)) return;
      if (a.get('span.type') !== 'llm_request') return;
      out.push({
        requestId: str(a, 'request_id'),
        sessionId: str(a, 'session.id'),
        agentId: str(a, 'agent_id'),
        ts: toMs(span.startTimeUnixNano, undefined),
      });
    });
  } catch { return []; }
  return out;
}

module.exports = { parseLogs, parseTraces };
