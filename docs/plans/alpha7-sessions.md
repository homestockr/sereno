# alpha.7: Sessions tab (draft brief)

Status: brief agreed and steps not yet written. Ships as `2.0.0-alpha.7`, after alpha.6.

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

## Open, for the plan

- Hook coverage: which events `wiring.js` registers today, and whether `UserPromptSubmit`
  and `Notification` reach the ledger path.
- Event volume per session, and whether to coalesce tool start/end pairs into one row.
- How reconciliation state is shown (statusline total vs the ledger).
- The waterfall renderer (inline SVG, no dependency).
