# alpha.7: Sessions tab (draft brief)

Status: brief agreed; steps written 2026-10-25 (below). Ships as `2.0.0-alpha.7`, after
alpha.6. Includes the Pipeline tab layout fix Robe flagged on 2026-10-25.

## The question it answers

"What happened during this coding session, and where did the time and money go?" (Robe,
2026-10-16). It is Sereno's searchable run history. The spec calls it "History", meaning past
sessions, alerts and reconciliation state.

A **session** is one Claude Code conversation. A **task** can span several sessions.
Sessions investigates execution. Pipeline follows the work through to completion.

## Layout

It uses the same compact list-and-detail layout, and the same navy theme, as Projects and Pipeline.

- **Session list:**
  - each row shows the project and branch, the state (running, waiting, idle or ended), the
    start time and duration, the cost (est.) and the prompt count;
  - a short activity summary when one is available. It comes from tool-name counts, the
    pipeline task, or the branch brief's Now line, and never from prompt text;
  - search and filters work over project, branch, state and date.
- **Selected session:** a timeline waterfall showing:
  - the main thread and each subagent run, labelled by role and model;
  - tool calls by name, with their timings;
  - permission waits in amber, labelled with their duration (amber still means "needed you");
  - review outcomes and the repairs that followed;
  - cumulative cost (est.);
  - attribution uncertainty and the ledger's reconciliation state.
- **Example:** a 47-minute session where 5 minutes were permission waits, the first review
  found two defects, and the second review passed.

### Concept (Robe, 2026-10-16)

A GPT-generated concept, "Sereno Sessions: trace, waits, and repair", is kept locally.

- **Header:** a Today / 7d / 30d switch.
- **Left list:** search, the filters All / Running / Ended, and rows grouped by day (project,
  state pill, branch, time range, duration, cost est.).
- **Detail header:**
  - project, state, branch, duration, cost (est.), prompt count, time range and the
    reconciliation chip ("Ledger matches statusline", or the difference);
  - "View project" (navigation);
  - sub-tabs **Timeline** / **Requests** / **Reviews (N)**.
- **Timeline:**
  - a cumulative cost line (est.) on top, then one lane per run on a shared time axis;
  - permission waits as amber bands across all lanes, labelled with their duration;
  - tool names on hover;
  - review markers carry the outcome shape and the findings count;
  - the legend shows explicit / inferred / unattributed.
- **Below the timeline:**
  - "What held it up": elapsed time, then the event (permission wait, review blocked with N
    findings, Builder resumed, review passed);
  - "Session facts": total permission waits, Builder active time over N runs, the review path
    (block → repair → pass), and the attribution count.

Corrections, so it fits Sereno's rules:
1. The main thread is labelled **"Main session"**, not "Architect". The spec counts it as
   Architect only when the config says so.
2. Lane subtitles never come from Task descriptions, which are tool input. A lane shows the
   agent type and model, plus derived context only. For example, a Builder attempt whose
   pipeline record follows a block reads "Repair".
3. Inferred hatching applies only to subagent requests with no agents join. The main
   thread is always explicit.
4. No pagination: the list scrolls, grouped by day.
5. No "⋯" menu.

## Cross-links

| From | Sessions opens at |
|---|---|
| Projects | that project's recent sessions |
| Pipeline | the task's review or repair, in the session where it ran |
| Spend | the selected turn and the activity around it |

## Data decision (Robe, 2026-10-16)

A new ledger table, `session_events`. Each row holds the session id, the time, the kind
(tool start or end, permission wait start or end, prompt submitted, stop), the tool name and
the agent id.

- MCP tool names are stored as given.
- No inputs, prompts, responses or commands are stored. This is still within the privacy
  invariant.
- It has the same retention and "Clear history" as the rest of the ledger.
- It needs a schema migration (`MIGRATIONS`).
- The session's branch is captured at session start from the repo poller.

## Findings (code read 2026-10-25)

- **Hook coverage.**
  - `wiring.js` registers every event the tab needs: SessionStart and SessionEnd,
    UserPromptSubmit, PreToolUse and PostToolUse, Notification, Stop, StopFailure,
    SubagentStart and SubagentStop, and PreCompact.
  - All of them reach `ledger.recordHook`. Today it keeps only `sessions` (from SessionStart)
    and `agents`, and ignores everything else.
- **Timestamps.** Hook payloads carry no time. The shim sends `receivedAt`, but the
  collector discards it and the ledger stamps `Date.now()`.
- **Pairing.** PreToolUse and PostToolUse share `tool_use_id`, and PostToolUse carries
  `duration_ms`. The store already pairs them.
  - A denied tool never gets a PostToolUse.
  - `Agent`'s PostToolUse returns at launch, not when the agent finishes.
- **OTLP.** It carries better tool data, the `tool` and `tool.blocked_on_user` spans with real
  durations, but the allowlist drops them and traces are beta.
- **Ledger gaps.**
  - `sessions` has no `branch` and no end time.
  - Prompt count is not stored.
  - `prune` runs only at open.
  - "Clear history" does not exist; the README tells users to delete `sereno.db` by hand.
  - `reconcile()` exists but nothing calls it.
- **Rendering.** It is hand-built SVG in `console.js` (`chartSvg`, `sparkSvg`), under a CSP
  that allows no inline styles, so widths go through `data-w` and `applyWidths`. The Projects
  navigator's list-and-detail helpers (`nav*`, `.pnav`) can be reused.
- **Branch.** There is no cwd-to-branch helper. Use the longest matching worktree path from
  `repos.snapshot()`. It is often `null` at SessionStart, so backfill it.
- **Pipeline panel.**
  - `.body.pipe .attn-col` is a fixed 340px column with no `min-width:0` or overflow rule.
  - Long tokens rely on `overflow-wrap:anywhere` on only some children.
  - The main area has nothing below the run strip.

## Decisions (architect, 2026-10-25; Robe can overrule)

- **Source.** Hooks are the baseline, because they always arrive when wiring is on. OTLP
  `tool.blocked_on_user` spans refine the wait durations when traces are on (S5). Nothing
  depends on beta traces.
- **One row per tool call.** Insert on PreToolUse with `ended` empty, and fill it on
  PostToolUse by `tool_use_id`. Rows still open at Stop, StopFailure or SessionEnd close as
  `unfinished`. An `Agent` row's end is taken from that agent's SubagentStop, not its
  PostToolUse.
- **Permission waits.**
  - A wait starts at the PreToolUse of the tool that is pending when a `permission_prompt`
    arrives, not at the Notification, which lags about 8 s.
  - It ends at that tool's PostToolUse, or at Stop.
  - Only `permission_prompt` counts as a wait, the same rule as alerts.
- **Time.** Use the shim's `receivedAt`, clamped to within 5 s of the collector clock.
  Otherwise fall back to `Date.now()`.
- **Allowlist by key.** `session_events` stores only:
  - `session_id`, `ts`, `kind`, `tool_name` (≤ 128 chars, MCP names as given), `tool_use_id`,
    `agent_id`, `ended`, `duration_ms`, `outcome`, `prompt_id`;
  - nothing from `tool_input`, `tool_response` or `prompt`.
- **Pruning.** Retention covers the new table too, and `prune` also runs daily, not only at
  open.
- **"Clear history".** Build it: a Settings action with a confirmation that clears Sereno's
  own ledger. It is Sereno's own data, so it doesn't break "observes, never acts".

## Needs Robe

- **Prompt count and `<task-notification>`.** A background agent reporting back fires
  UserPromptSubmit, and only the prompt text tells it apart. Two options:
  - **(a)** At ingest only, check whether `prompt` starts with `<task-notification>`. Keep a
    boolean and never store or log the text. The tests enforce that the check reads only a
    fixed-length prefix.
  - **(b)** Never look at the text, and label the count "turns" instead of "prompts".
  - Recommendation: (b) for alpha.7, because it is the simpler privacy story. Revisit if
    "turns" proves misleading.

## Steps

- **S0, measure volume (before S1 is finalised).** Count PreToolUse events per session-hour
  in one real working session, using a counter in the collector behind a debug flag that
  stores counts only. Check that one row per call is fine at that rate, with an index on
  `(session_id, ts)`. Record the numbers here.
- **S1, ledger V2.** The migration adds:
  - `session_events` with the allowlisted columns above, and indexes `(session_id, ts)` and
    `(session_id, tool_use_id)`;
  - `sessions.branch` and `sessions.ended_at`.

  `recordHook` writes the events, pairs them, and closes them per the decisions. `receivedAt`
  is plumbed through. Prune covers the new table and runs daily. Tests cover:
  - the privacy canary: no input, response or prompt keys reach the database;
  - pairing, denied tools, Agent rows and waits;
  - pruning and the migration from V1.
- **S2, the API.** `/api/sessions?range=today|7d|30d` returns the list rows:
  - project, branch, state, start and end, duration, cost (est.) and turns.

  `/api/sessions/:id` returns the detail:
  - lanes (main session and each agent, by role and model), tool rows, waits, the cumulative
    cost series, review markers joined from pipeline records, and attribution counts;
  - the reconciliation state from `reconcile()`.

  Branch backfill comes from `repos.snapshot()`. It is read-only, behind the existing
  Host/Origin checks. Tests.
- **S3, the Sessions tab.**
  - A `TABS` entry, plus the list and detail built on the `nav*` helpers.
  - The Today / 7d / 30d switch, the All / Running / Ended filters, search, and day groups.
  - A detail header with the reconciliation chip.
  - The Timeline sub-tab: an SVG waterfall with a shared time axis and one lane per run.
    Waits appear as amber bands. The cost line sits on top. Inferred hatching applies only to
    subagent requests with no agents join.
  - Requests and Reviews sub-tabs.
  - "What held it up" and "Session facts".
  - Labels follow the five corrections above.
  - Look at it in a browser before committing.
- **S4, cross-links and "Clear history".**
  - Projects, Pipeline and Spend link to Sessions as in the table above.
  - The Settings action, with a confirmation step.
  - The README section on clearing history is replaced.
- **S5, OTLP refinement (optional).** Allowlist the `tool.blocked_on_user` span by key:
  `duration_ms`, `decision`, start and end times, `tool_use_id`. When it is present, it sets
  the wait duration. Update `docs/payloads.md` and the allowlist tests.
- **S6, the Pipeline layout fix.**
  - The panel gets `min-width:0` and contains its overflow, with paths breaking at `/`.
  - The selected task's findings and attempts move to a full-width area under the run strip,
    or the panel widens.
  - Choose after looking at both in a browser at 1360px, 1600px and 1920px, with Robe.
- **Then:** the red team on the branch, the installer, release notes, and publish (asking
  first).
