# Phase 2 — Spend in view

Status: ready to build · Branch: `feat/spend-in-view` off `main` · Ships as `2.0.0-alpha.2`

Goal: you can see what Claude Code cost you today without leaving the widget, and the
detail behind it in a console at `http://127.0.0.1:8787/console`. Everything reads the
Phase 1 ledger. Nothing new is collected.

Design baseline: `docs/design/console/` (`spend.html`, `widget-footer.html`, `style-sheet.html`
and the rules in its README). Spec exit: "today's spend survives a restart and matches the
Spend tab."

## Decisions (Robe, 2026-10-04)

- **Split by source, not role.** Main thread / subagent / auxiliary, which the ledger
  records reliably. Subagent rows may name the agent type. Role colours replace this in
  Phase 4. The mockups' role legend becomes a source legend; nothing else about the layout
  changes.
- **No budgets yet.** No target line, pace or budget figure. Budgets are their own step later.
- **Console is a browser tab.** "Open console" in the widget and tray opens the default
  browser. The same page works under `npm run serve`.

## Architect decisions

- **One query path.** The widget footer and the Spend tab both get "today" from the same
  ledger function through the same API. They cannot disagree except by refresh timing.
- **Day boundaries are local time on this machine.** A pure helper computes local midnight
  for a date; the ledger never guesses a timezone. 24h view uses hourly buckets.
- **Charts are hand-rolled SVG.** Stacked daily bars, one cumulative line and sparklines do
  not justify vendoring uPlot. The uPlot exception stays available for later phases.
- **Attribution on every figure.** Phase 1 only produces `explicit` and `unknown`: solid
  fill and grey hatch. Unattributed spend always shows with its request count `n`.
- **Every dollar figure ends in `est.`** Money stays integer micros until the last render.
- **No prompt text anywhere** (there is none to show). "Top 10 costliest prompts" groups
  by `prompt_id`. The mockup's "First tool" column is dropped: tool names are not stored,
  and storing them is out of scope.
- **Console nav shows Spend only.** Projects, Pipeline and Sessions arrive with their
  phases. No disabled placeholders.
- **Ledger off or no telemetry yet:** the footer keeps today's statusline total, labelled
  `list-price est.` exactly as in v1.3. The console shows an empty state that says why
  and how to turn spend history on. It never creates a database.

## Exit criteria (each is a test in `tools/test.js` under `[spend exit]`)

1. The widget's today figure and the Spend tab's today figure come from one function and
   are equal for the same ledger state.
2. Today's total survives closing and reopening the ledger.
3. A request at 23:59 local and one at 00:01 local land on different days, in both the
   daily and the hourly series.
4. Ledger off: `/api/spend/*` answers `{ enabled:false }`, the footer falls back to the
   statusline total, and no database file exists.
5. Every `/api/spend/*` response has only documented keys (no field outside the
   allowlist can appear). Session ids are shortened to 8 characters.
6. Every money string the renderer produces ends in `est.`.
7. `/console` and `/api/*` reject a foreign Host or Origin with 403.

## Steps

Each step is one Builder task. It ends with `npm test` green and adds its own tests. The
architect reviews and commits. Red team reviews the whole branch before merge.

### Step 0 — Ledger queries and local-time helpers

- `src/spendtime.js` (`// @ts-check`, pure): `dayStart(ms)`, `dayBounds(ms)`,
  `lastNDays(n, nowMs)` → `[{ day:'YYYY-MM-DD', since, until }]`, `hourBuckets(nowMs)` for
  the 24h view. Local time via `Date` setters, so DST days are 23 or 25 hours long. Test
  with fixed dates, including a DST change in `America/New_York` if `TZ` is honoured on
  the test machine; skip that one test with a note if not.
- `src/ledger.js`, new read methods. All take explicit `{ since, until }` ms bounds;
  none compute "today" themselves:
  - `series(buckets)` → per bucket `{ key, costMicros, bySource, byAttribution }`.
    One query per call, grouped in SQL by bucket index (`CASE` or a join against a temp
    VALUES list), not one query per bucket.
  - `projects({ since, until })` → per project `{ project, costMicros, bySource,
    byAttribution, requests }`, plus one `unattributed` row total. Sessions with no
    project row group under `null`, rendered "Unknown project".
  - `trend({ project, buckets })` → the 14-day per-project sparkline values.
  - `topPrompts({ since, until, limit = 10 })` → grouped by `prompt_id` (rows without
    one group by `request_key`): `{ ts (first), project, sessionShort, costMicros,
    models[], attribution }` where attribution is `explicit` only if every row is,
    `unknown` if every row is, else `mixed`.
  - `today(nowMs)` → `{ costMicros, bySource, byAttribution, requests, unattributedN }`,
    built on the same aggregation as `totals()`. This is the single source for exit 1.
- Tests: buckets sum to `totals()` for the same range; empty ranges return zeros, not
  missing keys; `topPrompts` ordering and grouping; `mixed` attribution.

### Step 1 — API, console route, and spend in the snapshot

In `src/collector.js`, behind the existing `localOnly` checks:

- `GET /api/spend/today`, `/api/spend/series?range=24h|7d|30d`,
  `/api/spend/projects?range=…`, `/api/spend/top-prompts?range=…`. The server computes
  bounds with `spendtime.js` from its own clock. Each response: `{ enabled, asOf, … }`.
  Ledger off → `{ enabled:false }`. Unknown `range` → 400. Ledger throws → 503.
- Keep `/ledger/summary` (shipped in alpha.1), unchanged.
- `GET /console` and `/console/*` serve `src/renderer/console/` with the same
  path-traversal guard as the widget's static route.
- Snapshot field `spend`: `{ enabled, todayMicros, bySource, byAttribution,
  unattributedN, hasTelemetry }`, from `ledger.today()`. Recompute only when an ingest
  succeeds (dirty flag) or the local day rolls over (a one-minute timer that checks
  `dayStart`). Never on every broadcast. `hasTelemetry` = any `requests` row today.
- Tests: each route on/off/throwing; foreign Host and Origin 403 on `/console` and
  `/api/*`; traversal blocked; snapshot `spend` updates after a `/v1/logs` post and not
  after a `/status` post; exit 5's key allowlist.

### Step 2 — Widget footer

`src/renderer/` (widget). Keep everything v1.3 shows. Add a footer block, per
`widget-footer.html`:

- "Today · estimated usage" with `$X.XX est.`, a cumulative line from 00:00 to now
  (SVG, from `/api/spend/series?range=24h`, refreshed when `snapshot.spend.todayMicros`
  changes, at most every 30 s), and a stacked source bar with the unattributed part
  grey-hatched. No budget line.
- Fallback: when `spend.enabled` is false or `hasTelemetry` is false, show today's
  statusline total as `list-price est.` exactly as v1.3 does, with a quiet one-line hint
  when spend history is on but no telemetry has arrived ("Waiting for telemetry from new
  Claude Code sessions").
- "Open console ↗" link in the footer and a tray item "Open console": main opens
  `http://127.0.0.1:<PORT>/console` via the existing `isWebUrl` guard.
- Pure functions (money formatting, bar segments, line points) are tested from source
  the way `mmss` and `setupCopy` are. Exit 6 lives here.
- Minimum text 11px. Shapes carry state; colour only reinforces. The amber banner
  rule is untouched.

### Step 3 — Console shell and Spend tab

`src/renderer/console/index.html`, `console.css`, `console.js`. No framework, no build
step. Same palette tokens as `style-sheet.html`, light and dark via
`prefers-color-scheme`.

- Shell: left nav with Spend only, "Local only" footer, header breadcrumb
  "Workspace / Spend" and "Synced just now" (time since last fetch).
- Summary line: `$X est. today · $Y est. this month · Z% unattributed (n=N)`.
- Daily usage cost: stacked bars by source, 24h / 7d / 30d toggle (24h = hourly). Axis
  label "USD · estimated". Legend: Main, Subagent, Auxiliary. Unattributed hatched.
- Projects × source (month to date): Main / Subagent / Auxiliary / Total columns, an
  attribution bar with percentages and `n`, a 14-day sparkline. Unattributed row under
  the table, "Included in project totals · Z% (n=N requests)".
- Top 10 costliest prompts: #, time, project, session (8 chars), estimated cost, model,
  attribution. Note: "Prompt text is never stored."
- Empty states: ledger off (how to turn it on), no telemetry yet (how to wire it), no
  spend in range.
- Refresh: on load, on tab focus, and every 60 s while visible. No SSE for the console.
- Render functions are pure and tested from source: summary line, bar geometry,
  percentages (rounded at the source, summing to 100 with the largest-remainder method).

### Step 4 — Attention panel (read-only)

The README puts the panel on every overview page. Phase 2 has the data for its first
half: sessions waiting on a permission, from `/state`.

- Amber only when a session is blocked on a permission. Otherwise it reads "All clear".
- It names the session and project and says to answer it in the terminal. No button
  in Phase 2: "Review in terminal" needs a main-process action from a browser page,
  which is a new attack surface. That button moves to Phase 3 with its own review.
- "Latest activity" waits for the Phase 3 brief and gate data.
- Tests: amber iff a blocked session exists; never amber for idle or unknown types.

### Step 5 — Exit tests, docs, release prep

- `[spend exit]` tests for criteria 1–7.
- README: "Spend history" section gains the footer and console, with a screenshot of
  each.
- `package.json` → `2.0.0-alpha.2`.
- Red team on `main...feat/spend-in-view`. Then Robe's click-through of the packaged
  build, then ask before merge, push or release.

## Out of scope for Phase 2

Roles and role colours, budgets and pace, alerts on spend, the Projects, Pipeline and
Sessions tabs, "Review in terminal" from the console, `inferred` attribution, storing
tool names, non-Windows code.
