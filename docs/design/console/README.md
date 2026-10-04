# Console mockups

Design baseline for the Sereno console and widget (spec phases 2–4). Static HTML at
1440×900: open any file in a browser. PNGs are renders of the same files. Sample data
is illustrative.

| Screen | File | Shows |
|---|---|---|
| Projects (default tab) | `projects-dark.html` | A review waiting on a decision; the attention panel in its amber state |
| Projects, calm | `projects-calm.html` | Nothing needs you: the panel goes quiet and keeps the activity feed |
| Projects, light theme | `projects-light.html` | Same screen on the light palette |
| Pipeline | `pipeline.html` | Each task as Plan → Build → Review → Merge, review runs, signals with sample counts, role routing |
| Pipeline signals | `pipeline-detail.html` | Current gate state per project, 30-day gate runs, outcomes (n=20), spend share by role, Default vs Lean preset |
| Spend | `spend.html` | Daily cost by role, projects × roles with attribution split, top 10 costliest prompts |
| Session timeline | `session-timeline.html` | One session as a trace waterfall with permission waits and gate outcomes |
| Widget | `widget-footer.html` | The 360px widget in three states: calm, repair, decision. Spend joins the footer |
| Style sheet | `style-sheet.html` | Role colours (dark/light), attribution fills, gate shapes, amber, type, spacing, live-state shapes |
| Colour check | `role-colour-cvd.png` | Role colours under protan, deutan and tritan simulation (Machado, severity 100) |

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
- **Minimum text size 11px,** in the console and the widget.
- **The widget keeps what v1.3 shows** (context bars, 5-hour/7-day limits); estimated
  spend is an added footer, and the amber banner sits under the header.

## Colour check

Role colours stay distinguishable in all three simulations on dark. On light, Scribe
and Red team move close together under deutan, so role labels must always accompany
colour (they do on every screen).

Generated with GPT 6.1 Sol from the spec, then revised in review (2026-10-04).
