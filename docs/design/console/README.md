# Console mockups

Design baseline for the Sereno console (spec phases 2–4). Static HTML at 1440×900:
open any file in a browser. PNGs are renders of the same files. Sample data is
illustrative.

| Screen | File | Shows |
|---|---|---|
| Projects (default tab) | `projects-dark.html` | A review waiting on a decision; the attention panel in its amber state |
| Projects, calm | `projects-calm.html` | Nothing needs you: the panel goes quiet and keeps the activity feed |
| Projects, light theme | `projects-light.html` | Same screen on the light palette |
| Pipeline | `pipeline.html` | Each task as Plan → Build → Review → Merge, review runs, signals with sample counts, role routing |
| Spend | `spend.html` | Daily cost by role, projects × roles with attribution split, top 10 costliest prompts |
| Session timeline | `session-timeline.html` | One session as a trace waterfall with permission waits and gate outcomes |

## Rules these mockups settle

- **Sereno observes; it never acts.** The attention panel's button is "Review in
  terminal": it raises the session's terminal, same as the widget. Decisions happen
  in Claude Code.
- **The attention panel** appears on overview pages (Projects, Pipeline, Spend). It is
  amber only when a decision is pending; otherwise it reads "All clear" and shows
  latest activity. A single-session page drops the panel for width and keeps the
  amber "decision needs you" pill.
- **Amber means one thing:** a decision or permission wait needs the user.
- **Shapes carry state;** colour only reinforces it. Gate outcomes: pass = filled dot,
  block = slashed ring, needs context = question ring, error = triangle,
  skipped = dash.
- **Attribution** is shown on every spend figure: solid = explicit, role-hatched =
  inferred, grey-hatched = unattributed. Every dollar figure is labelled `est.`.
- **Rates and shares carry n.** Pipeline numbers describe; they don't grade.
- **No prompt text anywhere.** "Top 10 costliest prompts" lists time, project,
  session, first tool, cost, model and attribution.
- **Minimum text size 11px.**

## Not yet revised

The widget footer (keep the existing 5-hour/7-day meters and context bars; the amber
banner stays under the header) and the one-page style sheet still need a pass in this
layout.

Generated with GPT 6.1 Sol from the spec, then revised in review (2026-10-04).
