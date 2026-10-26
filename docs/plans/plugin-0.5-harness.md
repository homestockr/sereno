# Plugin 0.5.0: checks that run the app, agreeing on done, measuring the reviewer

Status: planned (Robe, 2026-10-25). It starts after 0.4.0 is merged. Item H4 is app-side and
ships with alpha.8.

## Why

Anthropic's "Harness design for long-running apps"
(https://www.anthropic.com/research/harness-design-long-running-apps), read 2026-10-25.

Its harness is a planner, a generator and an evaluator. The evaluator clicks through the
running app (browser, API, database), and the agents agree a sprint contract before any code
is written.

Lessons that hold for Sereno:
- A separate reviewer is load-bearing, because the builder judging its own work is lenient.
- Handoffs go through files and git.
- A full harness pays off only past what one model does reliably alone. Their full harness
  cost over 20 times a solo run, and our own bench showed no gain on small tasks.
- Every harness component encodes an assumption, so remove one piece at a time to find out
  which ones carry weight.

This session showed the gap that matters most. The Sessions tab passed 865 tests and still
needed three rounds of visual fixes, because tests check markup, not behaviour.

## Items

**H1. Runnable acceptance checks.**
- A spec may carry a `checks` list in a fenced block under its acceptance criteria. Each check
  is one of:
  - `cmd: <command>` plus `expect: exit 0 | stdout contains <text>`;
  - `http: <GET url>` plus `expect: status <n> | body contains <text>`;
  - `browse: <url>` plus `look: <one line of what to verify>`.
- `/sereno:task` writes checks when a criterion can be checked by running something.
- The test step runs the `cmd` and `http` checks, with a timeout and output capped like the
  suite. Results go into the test record: pass or fail per check, never output beyond the
  first lines.
- `browse` checks go to the red team. It gets browser tools only when the spec has a `browse`
  check (Claude in Chrome or Playwright MCP, whichever the user has). Without such a tool,
  the gate records them as `unverified`, which is not a pass.
- A failing check is a defect, so it leads to a repair.
- Never run against a remote host the spec doesn't name. Only localhost and hosts the user
  names count.

**H2. Agree on "done" before building.**
- For tasks that would get the full review (not light, per `sereno.js reviewer`), the red
  team reviews the spec before the build. It checks three things:
  - Is each criterion testable?
  - Are there runnable checks where there could be?
  - Is the scope one reviewable change? A rough guide is up to about 400 lines and one
    concern.
- The result is `agree`, `revise <points>` or `split <proposal>`.
- `/sereno:next` runs this as a step before the first build and stops on `revise` or `split`
  with that line. The person revises with `/sereno:task`.
- It is recorded so it shows up in costs. Light tasks skip it.

**H3. Stub detection, done in code.**
- The review pack lists markers added in the diff:
  - TODO, FIXME and XXX;
  - "not implemented";
  - `throw new Error('TODO` and the equivalents in common languages;
  - empty function bodies (a simple heuristic);
  - skipped tests (`.skip`, `xit`, `@pytest.mark.skip`).
- The red team checks each one against the acceptance criteria. A stubbed criterion is a
  defect.

**H4 (app, alpha.8). Measure the reviewer.**
- A task created with `--fixes <merged task>` means the review passed something it shouldn't
  have.
- The Pipeline tab shows escaped defects per reviewer and per review size (light or full):
  merges, follow-up fixes, and the rate.
- It shows these next to the cost per merge (est.). That lets a person see what each role
  costs against what it catches, and decide whether to change the presets.
- It is read-only and observes the records only.

**H5. Remove one piece at a time, as a documented practice.**
- The README describes using H4 to trial a lighter setup: for example, turn `light` on for
  more kinds, or try the lean preset for a week, then compare escaped defects and cost.
- It is documentation only. Nothing switches automatically.

## Not doing

- **Context resets.** The article's authors dropped them once compaction worked.
- **A separate planner agent.** `/sereno:task` already plays the planner's part, and their
  planner existed mainly to stop under-scoping.

## Steps

- **P1:** H3, the stubs in the review pack. It is small, so it goes first.
- **P2:** H1, the checks in specs, the test step and the red team.
- **P3:** H2, the spec review step in `/sereno:next`.
- **P4:** H5 in the README; H4 rides alpha.8.
- Then the red team on the branch, the end-to-end run, and merge (which is the release).
