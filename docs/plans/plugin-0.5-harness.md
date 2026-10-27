# Plugin 0.5.0: checks that run the app, agreeing on done, measuring the reviewer

Status: P1–P4 built on feat/plugin-0.5 (2026-10-26); red team and an end-to-end run with a browse
check pending. Item H4 is app-side and ships with alpha.8.

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

## H1 decisions (architect, 2026-10-26)

H1 is split. **P2a** covers `cmd` and `http` checks, which are plain code. **P2b** covers `browse`
checks, which need browser tools for the red team. P2b waits until it is confirmed how an
agent's `tools` list can admit MCP browser tools while staying read-only.

**The format.** One fenced block whose info string is `checks`, under the acceptance criteria.
Each item is a small YAML-like list entry; nothing else in the block is valid:

````
```checks
- cmd: npm run lint
  expect: exit 0
- cmd: node bin/cli.js --version
  expect: stdout contains 1.4.0
- serve: npm run dev
  ready: http://localhost:3000/health
- http: http://localhost:3000/api/items
  expect: status 200
- http: http://localhost:3000/
  expect: body contains <h1>Items</h1>
- browse: http://localhost:3000/items
  look: the empty state says "No items yet"
```
````

- **Parsing.** `spec.js` parses the block and refuses a malformed one with exit code and message
  `invalid_checks <line>`. The limits are 20 checks per spec and 500 characters per value. At
  most one `serve`.
- **Writing.** `/sereno:task` writes checks only where a criterion can be checked by running
  something, and never invents commands the repo doesn't have.
- **When checks run.** `sereno.js test` runs them only at head, after the suite, in the repo
  root.
  - Check results don't affect the base or head suite comparison.
  - A failing check is a new failure. Its name is `check <n>: <kind>`, it gives
    `diagnosis: defect`, and so it leads to a repair.
  - A check that times out is a failure as well.
- **`cmd`.** It runs through the platform shell with a 120 s timeout per check and the tree
  killed on timeout (reuse `killTree`). `expect` is either `exit <n>` or
  `stdout contains <text>`, the second meaning a plain substring of the first 1 MiB.
- **`serve` and `ready`.**
  - These are optional. The test step starts `serve` in the background, then polls `ready` with
    GET until it returns any 2xx or 3xx.
  - It polls every 500 ms for up to 60 s. If `ready` never comes, every `http` check fails as
    `server_not_ready`.
  - The process tree is always killed afterwards, including on the interrupt and cleanup paths
    `testrun.js` already has.
- **`http`.**
  - It sends a GET only, with no redirects followed, a 10 s timeout and the body read capped
    at 256 KiB.
  - `expect` is either `status <n>` or `body contains <text>`.
  - **Host rule:** the URL's host must be `localhost`, `127.0.0.1` or `[::1]`, or appear in the
    spec front matter `check_hosts: [..]`. Only `/sereno:task` writes that list, from hosts the
    user names. Any other host is refused at parse time with `invalid_checks host`.
  - It accepts only the `http:` and `https:` schemes.
- **The record.** The test record gains `checks: [{ n, kind, target, result, detail }]`.
  - `result` is one of `pass`, `fail`, `timeout`, `server_not_ready`, `refused` or
    `unverified`.
  - `target` is the command or URL, capped at 200 characters. This is spec text, which the
    record already holds.
  - `detail` is at most the first 3 lines of output, 300 characters in all, with control bytes
    stripped. It is never the full output.
  - The full logs go to `.sereno/cache` as the suite logs do.
- **`browse` before P2b.** The test step records each `browse` check as `unverified` and does
  not fail on it. The review pack lists them under "Browse checks (not yet verifiable)".
  - `unverified` is not a pass, so it works like a hold.
    - `sereno.js next` and the `merge` skill print "N browse checks unverified: check them
      yourself" with each URL and `look` line, in the merge stop line.
    - Typing `/sereno:merge` is the person's yes, the same as a hold.
  - No new flag or record type is added for this.
- **Spec integrity.** Checks are read from the spec at the revision recorded on the attempt. A
  spec edited after the build is already `spec_changed`, so a Builder can't loosen a check
  without that showing.

## P2b decisions (architect, 2026-10-26)

Sources: the Claude Code subagents docs (https://code.claude.com/docs/en/sub-agents.md).
- `disallowedTools` removes tools from what an agent inherits. An agent with no `tools` list
  inherits every built-in and MCP tool.
- A `tools` list can take `mcp__<server>__*`.
- A per-spawn tool list is not documented. None of this has been tried on a live install.

**The agent.** A new `sereno:red-team-browse`. Its prompt is the red team's prompt plus the
browse rules. It has no `tools` list and sets `disallowedTools: Write, Edit, NotebookEdit`, so it
inherits whichever browser MCP the user has (Claude in Chrome, Playwright or others) and still
cannot edit files. `disallowedTools` is `Write, Edit, NotebookEdit, WebFetch, WebSearch, Agent, Task`
(red team rt1), so it cannot fetch the web, search or spawn agents. It still inherits EVERY MCP
server the user has (databases, deploys, design tools, messaging). The only limit on those is the
prompt, which says to use browser tools only: an instruction, not a block.
- It is read-only by instruction for Bash, as the other red-team agents are.
- It may open only the URLs of the spec's `browse` checks, or same-origin pages reached from
  them. It never submits forms, signs in or enters data.
- Its model tier is the same as `sereno:red-team`, which is Fable.

**Choosing the agent.** `sereno.js reviewer` returns `sereno:red-team-browse` when the spec has
at least one `browse` check and the review is full. A light review with browse checks gets the
full browse reviewer. Without browse checks nothing changes.

**The dev server during review.** `sereno.js serve --start` and `sereno.js serve --stop`.
- `--start` launches the spec's `serve` detached, waits for `ready`, and writes its pid to
  `.sereno/cache/serve-<task>.json`.
- `--stop` kills the process tree.
- The ship skill starts it before spawning the browse reviewer and always stops it afterwards,
  on every path including errors.
- `sereno.js doctor` reports a leftover pid file.

**The verdict.** The verdict JSON gains `checks: [{ n, result: pass | fail | unverified, note }]`.
- A `fail` makes the outcome `block`. The gate enforces this, so a red team that says `pass`
  with a failed check is recorded as `block`.
- `unverified`, for example when no browser tool is present at runtime, keeps the P2a hold
  behaviour.
- The gate records the per-check results.

**The check before release.** On a real install, run `/agents` and confirm that
`red-team-browse` shows MCP browser tools and none of Write, Edit, WebFetch, WebSearch or Agent. Spawn it once on a spec with a
browse check.

## H2 decisions (architect, 2026-10-26)

- **When the review runs.** Before any build, the diff is unknown, so the choice uses only the
  spec.
  - The review is skipped when the spec's `kind` is in `roles.redTeam.light.kinds`. In the
    default preset that list is empty, so nothing skips; in `lean` it is `mechanical`.
  - It is also skipped when the new config `roles.redTeam.specReview` is `false`. That setting
    is `true` in `default` and `false` in `lean`.
  - `sereno.js spec-review-needed --task <t>` returns `{ needed, reason }`. It is read-only and
    in code, so no model makes the call.
- **Who reviews.** The configured red-team agent, which is Fable in `default`, in a spec-review
  mode.
  - The red-team agent files gain a short "Spec review" section. When the prompt says spec
    review, the agent reads only the spec and the repo files it needs to judge three things:
    whether each criterion is testable, whether runnable `checks` are present where they could
    be, and whether the scope is one reviewable change (about 400 lines or fewer, one concern).
  - It returns `{ "outcome": "agree" | "revise" | "split", "points": [<= 8 short strings] }`.
  - It never sees a diff. There is none yet.
- **The record.** `sereno.js spec-review --file <verdict.json> --task <t>` validates the verdict
  and writes a `spec_review` record.
  - The record holds `task`, `spec_revision`, `outcome`, `points` (cleaned, capped),
    `agent_name`, `agent_id`, `session`, `reviewed_at`.
  - It is written through the same fsafe and records path as gate records.
  - Outcomes outside the three are refused.
- **`sereno.js next`.** It adds a step `spec_review`, which comes before `build`. It applies
  when the review is needed and there is no `agree` record for the spec's current
  `spec_revision`.
  - On `revise` or `split` for the current revision, it stops with `step: decide`. The reason is
    "spec review: revise — <first point>" (or split), and the command is `/sereno:task <task>`.
  - A new spec revision needs a new review.
  - Escape hatch: running `/sereno:build <task>` directly still works, because build doesn't
    require the review. The stop line says so in one clause.
  - No new flag is added.
- **The skills.** `skills/next/SKILL.md` runs the spec-review step before following build:
  spawn the red team in spec-review mode, write the verdict to the cache dir, then run
  `sereno.js spec-review`. It keeps the foreground and Bash-only rules. `build` itself is
  unchanged.
- **The app.** The app's pipeline reader must ignore or tolerate the new record type, and a
  test proves it. Showing it in the Pipeline tab is out of scope (alpha.8). Its spend is
  attributed to the Red team through the agents join, the same as other red-team spawns.

## Steps

- **P1:** H3, the stubs in the review pack. It is small, so it goes first. Done: 73fadb4.
- **P2a:** H1 `cmd`, `serve`/`ready` and `http` checks, plus `browse` recorded as unverified
  (see the decisions above). Done: a37bd37.
- **P2b:** H1 `browse` checks verified by the red team with browser tools. Done: f64b6e3.
- **P3:** H2, the spec review step in `/sereno:next`. Done: 1547107.
- **P4:** H5 in the README; H4 rides alpha.8. Done: P4: this commit.
- Then the red team on the branch, the end-to-end run, and merge (which is the release).
