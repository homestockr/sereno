# Phase 4b — Pipeline view

Status: ready to build · Branch: `feat/pipeline-view` off `main` · Ships as `2.0.0-alpha.5`

Goal: the console's Pipeline tab answers "is the model pipeline working, and does a task
need me?" It reads the files the Sereno plugin writes under each repo's `.sereno/`,
shows active tasks and gate state, and computes role spend and the spec's pipeline signals.
It raises "Review needs a decision" the way "needs you" works today. The app offers the
plugin, and it retires its own `/brief`. Sereno observes; the plugin acts.

Spec: "Views › Console", "Alert rules", "Model-role pipeline › Attribution" and "Pipeline
signals" in the architecture spec. Design baseline: `docs/design/console/pipeline.png`,
`pipeline-detail.png` and the README's rules (amber only for a pending decision, shapes
carry state, rates carry n, every $ labelled `est.`, no prompt text, 11 px minimum).

## Decisions (Robe, 2026-10-15)

- **One release** for all of 4b: the tab, role spend, pipeline alerts, offering the plugin.
- **The tab keeps the core and the signals.** It drops the Default vs Lean preset
  comparison and the 24h/7d/30d toggle. The window is a fixed 30 days.
- **Read the plugin's files on the existing poll.** No SQLite copy of attempts or gates,
  and the plugin never posts to the collector (it must work without the app).

## Architect decisions

- **One rule set.** The app requires the plugin's pure modules from `plugin/bin/lib/`
  (`recovery.js`, `config.js`, `fsafe.js`) instead of re-implementing them, so the tab
  can't disagree with `/sereno:ship`. `package.json` `build.files` adds
  `plugin/bin/lib/**/*` and `plugin/agents/*.md`. Version skew is accepted: the app
  bundles the plugin version from the same commit.
- **The app's reader guards before the plugin code reads.** `recovery.decide` reads
  `.sereno/attempts` and `.sereno/gates` itself with `lstat` and a 1 MB cap, but it does
  not check containment. `src/pipeline.js` first refuses a symlinked `.sereno`,
  `attempts` or `gates` directory (the `briefs.js` checks: local path, `lstat`, realpath
  containment), and only then calls `decide`.
- **Fields come from fixed lists.** Gate findings keep `severity`, `kind`, `file`,
  `line` and `summary` (summary capped at 300 chars, control chars stripped). They are
  reviewer text about code, never prompts. They are served to the console and never
  written to disk by the app.
- **Role map.** `agent_type` → role: `sereno:builder`, `sereno:builder-haiku`,
  `sereno:builder-opus` → Builder; `sereno:red-team`, `sereno:red-team-lean` → Red team;
  `sereno:scribe` → Scribe. The main thread shows as "Main session" (the spec counts it
  as Architect only when config says so; the plugin's config has no such field).
- **Attribution.**
  - `explicit`: the request's `agent_id` (from a trace span) joins `agents.agent_type`
    for the same session, and that type is in the role map.
  - `inferred`: no `agents` join (no span link, or a span-linked agent whose type was
    never recorded; decided 2026-10-15), the request is a subagent request, and its model belongs
    to exactly one role among the bundled `plugin/agents/*.md` models. Today that is only
    Fable → Red team; Opus, Sonnet and Haiku are each used by two or more roles and never
    infer. The rule is computed from the agent files, not hard-coded.
  - otherwise unchanged (`unknown`, shown as "Unattributed").
  - Computed at query time. Stored `attribution` values are not rewritten.
- **Red-team $/merge (est.):** for each gate with `outcome: pass` whose head was merged,
  sum ledger requests with the gate's `session_id` and `agent_id`. Gates without an
  `agent_id` are left out of the figure and counted in its n note.
- **Alert state lives in memory,** keyed by `project/task/attempt`, like
  `_blockedNotified`. A restart re-raises an open decision once, which is acceptable.

## Exit criteria (each is a test in `tools/test.js` under `[pipeline exit]`)

1. A fixture repo with a task in each state (running, built, repairing, decide, ready
   to merge, merged, stopped, expired) yields the right card stage for each.
2. A `decide` raises one "Review needs a decision" toast; a newer attempt moves it to
   `reviewing`; a second `decide` reopens it; nothing re-fires without a new episode.
3. A symlinked `.sereno/attempts` is refused before any plugin code reads it.
4. `/api/pipeline` responses contain no field outside the allowlist.
5. Role spend splits explicit / inferred / unattributed, and Sonnet is never inferred.
6. Plugin detection reports installed / not installed / not detected (corrupt file).
7. The app's `/brief` is removed only when its hash matches; a conflict stays.

## Steps

Each step is one Builder task. It ends with `npm test` green and adds its own tests,
using temp git repos made with `git init` in the OS temp dir. Fixtures are written by the
tests, never copied from `samples/`. No test binds 8787 or 8797, and none runs `claude`.
The architect reviews and commits. The red team reviews the whole branch before merge.

### Step 0 — Bundle the plugin's rules

- `package.json` `build.files`: add `plugin/bin/lib/**/*` and `plugin/agents/*.md`.
- `src/pipeline.js` (`// @ts-check`) requires `../plugin/bin/lib/recovery.js` and
  `config.js` by relative path.
- Tests: a lint test that the `files` globs cover every module `recovery.js` and
  `config.js` require; requiring them from `src/` works.

### Step 1 — Reader

`src/pipeline.js`:
- `readRepo(root)` → `{ config, tasks: [{ task, spec, attempts, gates }] }` or `null`.
  - Guards as decided above. Caps: 200 attempt files and 200 gate files per repo,
    newest first by name; 256 KB per file; spec front matter only (no body).
  - `config` is the plugin's effective config (`config.js`), with `tests.command` and
    `tests.setup` dropped (commands are never served).
  - Malformed files are skipped and counted; nothing throws.
- Tests: each guard, the caps, malformed JSON, unknown fields dropped, commands dropped.

### Step 2 — Stage per task

In `src/pipeline.js`:
- `taskView(repo, task, git)` → `{ stage, step, reason, attempt, gate, findings, startedAt,
  updatedAt, reviewRuns }`.
  - A spec with no attempts yet → Architect ("Spec written"); `decide` is not called
    (it throws `not_found` there). `listAttempts` passed to `decide` is the guarded
    listing from Step 1, and `currentHead` / `currentSpecHash` come from git and the
    spec file.
  - `recovery.decide` gives `next` and `reason`. Stage map: `retry`/`repair` → Builder
    ("Fixing N findings" for repair); `review` → Red team; `decide` → decision; `merge`
    → "Ready: run /sereno:merge"; `done` → stopped.
  - Merged: the latest gate's `head_commit` is an ancestor of the spec's `base_branch`
    (`git merge-base --is-ancestor`). Merged and stopped tasks leave the cards.
  - Expired: no attempt or gate file newer than 7 days. Shown grey, never alerts.
- `repos.js` fingerprints `.sereno/attempts`, `gates` and `specs` the way it does
  briefs, and recomputes a project's tasks only when the fingerprint or a task branch
  tip changes.
- Tests: every state in exit criterion 1, a moved branch tip (`head_moved`), a changed
  spec (`spec_changed`), git errors keep the last good view.

### Step 3 — Signals and role spend

- `src/pipeline.js` `signals(projects, now)` over 30 days: gate state per project; gate
  outcomes with n; rework per task (gate runs before the first pass, by `task_id`),
  median and max with n; runs this week.
- `src/ledger.js`:
  - `roleSpend(sinceMs, roleMap, inferModels)` → per role: cost (est.), and the
    explicit / inferred / unattributed split. Main session and auxiliary rows stay
    their own buckets.
  - `spendForAgent(sessionId, agentId)` for red-team $/merge.
- Tests: the attribution rules in the decisions, Sonnet never inferred, a gate without
  `agent_id` excluded and counted, an empty ledger.

### Step 4 — API

- `GET /api/pipeline` in `src/collector.js`, via `handleApi`, with the same Host/Origin
  checks. Body: `{ projects: [{ id, name, tasks, idle }], signals, roleSpend, routing,
  plugin }`, each object built from an explicit key list. `routing` is role → model
  from the bundled agent files plus the effective `redTeam.fallback` / `onFallback`.
- Tests: the allowlist (exit criterion 4), no command or prompt text, a bad Host refused.

### Step 5 — Alerts

- `src/pipeline-alerts.js`: a pure state machine. Input: task views over time. Output:
  events `decision-open`, `decision-reviewing`, `decision-reopen`, `stalled`,
  `stalled-clear`.
  - Decision: open on `decide`; `reviewing` when a newer attempt or gate appears; reopen
    on the next `decide`. Fires once per episode.
  - A `running` attempt is a Builder at work: stage `builder`, never `decide` (recovery's
    "never finished" applies only after the Builder returned, inside /sereno:ship).
  - Stalled (build or repair): latest attempt `running` ≥ 10 min, and no live
    `sereno:builder*` subagent in a session whose cwd is in that repo for 10 min (from
    `store.js`'s live subagents). Clears on activity or when the attempt ends.
- `src/main.js`: decision → critical toast "<project>: review needs a decision", tray
  state as for "needs you"; click opens the console on Pipeline. Stalled → a normal
  toast. Expired tasks never alert.
- Console: decisions join the attention panel (amber, with "Review in terminal" when a
  live session in that repo exists); stalled rows are not amber.
- Tests: exit criterion 2, stalled fire and clear via an injected clock, expired silent.

### Step 6 — Console Pipeline tab

`src/renderer/console/`: route `pipeline`, nav order Projects, Spend, Pipeline.
- Header: active tasks · repairs · decisions · runs this week; amber "N decisions need
  you" pill only when one is open.
- Active task cards: project, task, branch, started; the Architect → Builder → Red team
  → Merge track with a status line per step; the repair loop marker; "Scribe · brief
  updated Xm ago"; "$X est. · N review runs".
- Idle repos: one line each ("No active task", "Gate off", "Latest review passed").
- Signals: gate state per project; 30-day outcome shapes with n; rework median/max (n);
  red-team $/merge (est., n); role spend share with its attribution mix; role routing.
- Empty state when the plugin isn't detected: the two install commands with copy
  buttons.
- Tests: the render functions on fixture API bodies (stages, amber only on decisions,
  `est.` on every $, n on every rate), the existing console tests still pass.

### Step 7 — Offer the plugin, retire `/brief`

- `src/wiring.js` `pluginStatus(home)`: reads `~/.claude/plugins/installed_plugins.json`
  read-only; `sereno@sereno` key present → `{ installed: true, version }`; absent →
  `{ installed: false }`; unreadable → `{ installed: false, detected: false }`.
- The widget setup row (`src/renderer/app.js`) and IPC (`src/main.js`, `preload.js`):
  - Not installed: the two commands, copy buttons.
  - Installed: "Pipeline plugin <version> installed".
  - The app's `/brief` still installed with a matching hash: "Remove /brief (replaced by
    /sereno:brief)" via `uninstallCommands`, same confirm dialog. Conflict: say so,
    leave it.
  - Remove the install action and `templates/commands/brief.md`.
- Tests: exit criteria 6 and 7; the old install IPC is gone.

### Step 8 — Exit tests, docs, release prep

- The `[pipeline exit]` tests.
- `npm update brace-expansion` (lockfile only; Dependabot #29–31).
- README (app): the Pipeline tab, the plugin offer, `/brief` retired. `CLAUDE.md`
  roadmap: 4b status. `docs/design/console/README.md`: note the dropped preset comparison
  and toggle.
- `package.json` version `2.0.0-alpha.5`.

## Known limits

- A Builder whose session dies without `SubagentStop` or `SessionEnd` keeps counting as
  present for 30 minutes, so its "Build stalled" alert can take about 40 minutes.
  Better: match the running attempt's `agent_id` to the live agent.

## Out of scope for 4b

The Default vs Lean comparison and the time toggle; non-pipeline alerts from the spec
(turn failed, over budget, stuck loop, role drift); a per-run config snapshot table;
persisted alert state; the app installing the plugin; non-Windows testing.
