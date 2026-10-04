# Phase 1 — Spend ledger

Status: ready to build · Branch: `feat/otlp-ledger` off `main` · Ships as `2.0.0-alpha.1`

Goal: Sereno keeps a durable, local, privacy-safe record of what every Claude Code
request cost, attributed to main thread, subagent or auxiliary work. Nothing in the
widget changes yet (that is Phase 2). Data contract: `docs/payloads.md` §6.

## Exit criteria (each is a test in `tools/test.js`)

1. Replaying the same OTLP input twice leaves every total unchanged.
2. Closing and reopening the ledger preserves spend.
3. Telemetry with no hooks still creates a session row.
4. A subagent request with no matching span stays `unknown`; nothing reassigns it later.
5. Privacy: after ingesting fixtures that contain `user.email`, account/org ids and
   a `user_prompt` event with prompt text, the raw `sereno.db` bytes (plus `-wal`)
   contain none of those values.
6. Ledger disabled (default) → no database file is ever created.

## Steps

Each step is one Builder task. It ends with `npm test` green, and it adds its own tests.
The architect reviews the diff and commits it. Red team reviews the whole branch before
it merges to `main`.

### Step 0 — Wire the hooks the store already handles (small)

`src/wiring.js` `EVENTS` lacks `SubagentStart` (the store uses it to re-admit resumed
agents since v1.3.1) and `StopFailure`. Add both. `SubagentStart` has no matcher.
Re-wiring must be idempotent: running it twice adds no duplicates. Test both.
Check `bin/emit.js` passes these events through unchanged. Don't otherwise touch emit.js.

### Step 0b — Handle `StopFailure` in the store (small)

Step 0 wires `StopFailure`, but `src/store.js` ignores it. A turn that ends on an API
error then leaves the session stuck on `thinking` or `running` until the next prompt.
The payload has never been captured (`docs/payloads.md` §6, Gaps), so read nothing
from it beyond what routing already reads (`session_id`, `agent_id`).

- An untagged `StopFailure` ends the turn: clear `_pending`, then set the state to `idle`.
- Leave `_agents` untouched. Background subagents can outlive the turn, and without a
  `background_tasks` list there is no authority to drop them. The next `Stop` reconciles.
- A tagged `StopFailure` (with `agent_id`) changes no top-level state.
- It never raises "needs you" and never calls `onBlocked`. A blocked session that gets a
  `StopFailure` goes to `idle`, and `_blockedNotified` resets as it does on `Stop`.
- No new widget state and no error UI. That is Phase 2, once a real payload is captured.
- Tests: running → `StopFailure` → idle with pending cleared; subagent count unchanged;
  tagged `StopFailure` is a no-op for top-level state; no `onBlocked` call; unknown
  extra payload fields are ignored.

### Step 1 — `src/otlp.js`: OTLP/JSON → normalized records (pure, no I/O)

`// @ts-check` + JSDoc. Exports `parseLogs(body)` and `parseTraces(body)`. Neither
function ever throws: a bad body returns `[]`.

**Allowlist, not denylist.** Read only the keys named here. Everything else, including
`user.id`, `user.email`, `user.account_id`, `user.account_uuid`, `organization.id`
and `terminal.type`, never leaves this module.

`parseLogs` walks `resourceLogs[].scopeLogs[].logRecords[]`. It keeps only records
whose `event.name` is `api_request`. Every other event is dropped here, including
`user_prompt`, `tool_result` and `assistant_response`. Output per record:

```
{ requestKey, requestId, sessionId, promptId, ts, model, querySource, source,
  agentName, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  costMicros, durationMs }
```

- Attribute values: read `stringValue`, `intValue` (number **or** decimal string,
  since OTLP int64 may be a string), and `doubleValue`.
- `costMicros` = `cost_usd_micros`, else `Math.round(cost_usd * 1e6)`. Always an integer.
- `ts` (ms) from `timeUnixNano` (string ns), else `event.timestamp`.
- `source`: `repl_main_thread` → `main`; `agent:*` → `subagent`; anything else
  (`generate_session_title`, `prompt_suggestion`, …) → `auxiliary`.
- `requestKey` = `request_id` when present, else `session.id + ':' + event.sequence`.
  This key is what makes replay idempotent.

`parseTraces` walks `resourceSpans[].scopeSpans[].spans[]` and keeps only
`span.type == llm_request`. Output: `{ requestId, sessionId, agentId|null, ts }`.
Main-thread spans have no `agent_id`.

Fixtures: hand-written synthetic files in `tools/fixtures/otlp-logs.json` and
`otlp-traces.json`, shaped like the real captures. Use fake ids and fake email
values, and include the identifier keys so the privacy test has something to catch.
Include one main request, one subagent request with a span, one subagent request
without a span, two auxiliary requests, one `user_prompt` carrying
`"prompt":"SERENO-CANARY-PROMPT"`, and an `intValue` given as a string. **Never copy
from `samples/`**: those captures hold real identifiers and are gitignored.

### Step 2 — `src/ledger.js`: SQLite via `node:sqlite`

`// @ts-check`. `openLedger({ file })` returns an object with methods. `file` defaults
to `path.join(config.home(), 'sereno.db')`; tests pass a temp `SERENO_HOME` or `':memory:'`.
Use `require('node:sqlite')` lazily inside `openLedger`. If it is unavailable, throw a
typed error, and the caller then runs with the ledger off.

- `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `user_version` migrations
  (start at 1).
- Tables (integers for money and time; no prompt, response, command or tool input
  columns, ever):
  - `requests(request_key PK, request_id, session_id, prompt_id, ts, model,
    query_source, source, agent_name, agent_id, attribution, input_tokens,
    output_tokens, cache_read_tokens, cache_creation_tokens, cost_micros, duration_ms)`.
    Index on `(session_id, ts)`, `(ts)` and `(request_id)`.
  - `spans(request_id PK, session_id, agent_id, ts)`: holds spans that arrive
    before their request.
  - `sessions(session_id PK, first_seen, last_seen, cwd, project, model)`
  - `agents(session_id, agent_id, agent_type, started, stopped, PK(session_id, agent_id))`
  - `status(session_id PK, ts, cost_micros)`: last statusline checkpoint.
- `ingestRequests(rows)`, in one transaction:
  - `INSERT OR IGNORE` on `request_key`.
  - Upsert the session row with first and last seen.
  - Attribution rules:
    - `main` and `auxiliary` rows are `explicit`, because the source itself says what they were.
    - A `subagent` row whose `request_id` already has a span with `agent_id` is
      `explicit`, and its `agent_id` is set.
    - Otherwise it is `unknown`.
- `ingestSpans(spans)`, in one transaction: insert into `spans`, then
  `UPDATE requests SET agent_id=?, attribution='explicit' WHERE request_id=? AND
  source='subagent' AND attribution='unknown'`.
  - Spans only ever upgrade `unknown` to `explicit`.
  - Nothing else ever reassigns attribution. There is no `inferred` in Phase 1.
- `recordHook(event, payload)`: allowlist `session_id`, `cwd`, `model`, `agent_id`
  and `agent_type`.
  - `SessionStart` upserts the session's cwd, project and model.
  - `SubagentStart` and `SubagentStop` upsert `agents`.
  - Ignore a stop for an unseen id with `agent_type: ""` (§6).
  - Never read `prompt`, `tool_input`, `tool_response`, `transcript_path` or
    `last_assistant_message`.
- `recordStatus(sessionId, costUsd, ts)`: upsert `status` only when the cost changed.
- `totals({ since, until })` returns `{ costMicros, requests, bySource, byModel,
  byAttribution, sessions:[{ sessionId, project, costMicros }] }`.
- `reconcile(sessionId)`: compare `status.cost_micros` with the sum of the session's
  rows where `ts <= status.ts` (statusline lags; §6). Return `{ ledgerMicros,
  statusMicros, deltaPct, ok }`. `deltaPct` is rounded to one decimal at the source,
  and `ok` means `|deltaPct| <= 2`.
- `prune(retentionDays = 90)` runs on open.
- `close()`: `PRAGMA wal_checkpoint(TRUNCATE)`, then close.

### Step 3 — Collector: `POST /v1/logs`, `POST /v1/traces`

In `src/collector.js`. `createCollector(store, port, { ledger })`, where `ledger` may be null.

- Same `localOnly` Host/Origin checks. Require `application/json`, and reply `415`
  otherwise (protobuf is not supported; say so in the body).
- Accept `content-encoding: gzip` via `zlib.gunzip` with `maxOutputLength` = the body
  cap. Raw cap for `/v1/*` is 8 MB; `/hook` and `/status` keep 1 MB.
- **Delivery contract:**
  - Parse the body, write it to the ledger, and only then reply `200 {}`.
  - If the write throws, reply `503` so the exporter retries. Idempotent keys make
    retries safe.
  - A parse failure is `400`.
  - With the ledger off, reply `200 {}` and drop the data. Nothing touches disk.
- The existing `/hook` and `/status` paths also call `ledger.recordHook` and
  `ledger.recordStatus` after the store, inside the existing try/catch. A ledger
  error must never affect the live store or the response.
- `GET /ledger/summary?since=<ms>&until=<ms>` returns `totals()` plus
  `{ enabled }`. With the ledger off it returns `{ enabled:false }`. Loopback checks apply.
- Tests:
  - Post the fixtures over real HTTP, then post them again: totals unchanged.
  - Wrong Host is rejected `403`; Origin `403`; text/plain `415`.
  - gzip body accepted.
  - Ledger throwing gives `503`.

### Step 4 — Config, opt-in, lifecycle

- `src/config.js`: add `ledger: { enabled: null|true|false, retentionDays: 90 }`.
  `read()` must carry it through (see the comment there about `write()` rebuilding from
  `read()`). `null` means "not asked yet".
- `src/main.js`: on ready, if `ledger.enabled === null`, show one native dialog:
  "Keep a local spend history? Sereno will record request costs on this computer.
  No prompts or code are stored." The buttons are Yes / Not now.
  - Not now writes `false`.
  - Yes writes `true` and then offers telemetry wiring (Step 5) as a **separate**
    confirmation, because that step edits `~/.claude/settings.json`.
  - Add a tray menu item to toggle the ledger later.
- Open the ledger when it is enabled. Pass it to the collector. Close it on `before-quit`.
- If `openLedger` throws, log it once, run without the ledger, and show "Spend
  history unavailable" in the tray tooltip.
- `tools/serve.js` follows the same rules: it reads config and opens the ledger if enabled.

### Step 5 — Telemetry wiring

In `src/wiring.js`: `wireTelemetry({ traces })` / `unwireTelemetry()`, plus
`npm run wire -- --telemetry`.

- Merge into `settings.json` `env`, reusing the existing backup-first path:
  ```
  CLAUDE_CODE_ENABLE_TELEMETRY=1
  OTEL_LOGS_EXPORTER=otlp
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8787
  # with traces (default on, gives explicit subagent attribution):
  OTEL_TRACES_EXPORTER=otlp
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
  ```
- **Conflict rule:** if any `OTEL_*` or `CLAUDE_CODE_ENABLE_TELEMETRY` key already
  holds a different value (for example, managed telemetry to a company collector),
  change nothing. Return `{ conflict: [keys] }`, and have the caller say so.
- Never set any `OTEL_LOG_*` content flag (user prompts, tool details, and so on). A
  test asserts that no key matching `/^OTEL_LOG_/` is ever written.
- Record what we set in `~/.sereno/wired.json`. Unwire removes only keys whose value
  still equals what we set.
- Tests: merge, idempotence, conflict, unwire restores, no `OTEL_LOG_*`.

### Step 6 — Replay and exit-criteria tests

- `npm run replay -- --otlp`: feed `samples/otlp-*.jsonl`, if present (local only), or
  else the fixtures, into a temp ledger twice, and print totals both times plus the
  reconcile result.
- Add the six exit-criteria tests above under a `[ledger exit]` section.

### Step 7 — Release prep (architect + Robe)

- `package.json` → `2.0.0-alpha.1`. Raise `engines.node` to `>=22.13`. CI already
  uses Node 22 (latest 22.x).
- README: a "Spend history (alpha)" section covering what is stored, where, how to
  turn it off, and that every figure is an estimate.
- `docs/payloads.md`: note the ingest allowlist.
- On Windows: `npm run dist:dir` then `npm run test:packaged`, and confirm the ledger
  opens inside the packaged app (the last open item from the `node:sqlite` check).
- Red team reviews `main...feat/otlp-ledger`. Then ask Robe before merge, push or release.

## Out of scope for Phase 1

Widget or console UI, `inferred` attribution, roles, budgets, metrics export,
protobuf OTLP, non-Windows code.
