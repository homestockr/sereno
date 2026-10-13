# Phase 4a — The Sereno plugin (pipeline in Claude Code)

Status: ready to build · Branch: `feat/plugin-pipeline` off `main` · Ships as plugin `0.1.0`
and app `2.0.0-alpha.4`.

Goal: a standalone Claude Code plugin that runs Sereno's model-role pipeline. The
architect writes a task spec. A Builder chosen per task implements and commits.
`/sereno:ship` runs the tests against the base commit, has the red team review the diff,
writes a gate file, repairs once, and asks you before merging. It works with no Sereno
app installed and on any OS Claude Code runs on. Phase 4b adds the app's Pipeline tab,
role spend and alerts, built against the files this phase writes.

Sources:
- Architecture spec, "Model-role pipeline": roles, flow, gate verdicts, briefs.
- "Builder Selection and Recovery": Builders, bounds, recovery path, attempt records. A
  plain-text extraction is in the architect's notes.
- Claude Code plugin docs: manifest, marketplace, skills, agents, hooks
  (code.claude.com/docs/en/plugins*).

## Decisions (Robe, 2026-10-13)

- Ship **both** a standalone plugin and the app. The plugin owns everything that acts;
  the app only observes the files the plugin writes. Users who don't want the app still
  get the full pipeline.
- **Split:** this phase (4a) ships the plugin. 4b ships the app side.

## Architect decisions

- **One repo, two things.** The plugin lives in `plugin/` in this repo. The repo root
  gets `.claude-plugin/marketplace.json` with one entry, `sereno`, whose `source` is
  `./plugin`. Install with `/plugin marketplace add homestockr/sereno`, then
  `/plugin install sereno@sereno`.
  - `plugin/` has no `package.json`, so Claude Code installs nothing. Plugin scripts use
    only Node built-ins.
  - The manifest pins `version`, so users move only on a release.
- **Names.** Skills: `/sereno:task`, `/sereno:build`, `/sereno:ship`, `/sereno:brief`.
  Agents: `sereno:builder`, `sereno:builder-haiku`, `sereno:builder-opus`,
  `sereno:scribe`, `sereno:red-team`, `sereno:red-team-lean`. The architect is the main
  session, as the spec says; it has no agent.
- **Models are fixed per agent.** Plugin agents can't have their model overridden per
  setting (not documented), so a preset chooses agent **variants** by name:
  - `default`: red team on Fable (`red-team`), falling back to Opus with
    `onFallback: "ask"`.
  - `lean`: red team on Opus (`red-team-lean`).
  - Builders come from the task spec in both presets: `builder` (Sonnet, default),
    `builder-haiku` and `builder-opus`.
  - We never pass a per-invocation model, matching the Builder spec's rule of "by agent
    name, no per-invocation model".
- **`pipeline.json`.**
  - Read from `.sereno/pipeline.json` in the repo, else `~/.sereno/pipeline.json`, else
    built-in defaults.
  - Shape follows the spec: `preset`; `roles.builder.default` and `options`;
    `roles.redTeam` (`agent`, `fallback`, `onFallback`, `maxBlockedRuns`, `enabled`);
    `recovery` (`repairs: 1`, `infraRetries: 2`, `taskBudgetUsd: null`).
  - Agent names must be one of the plugin's own; unknown keys are kept and ignored.
  - `config_hash` = sha256 of the effective config, recorded in every gate and attempt
    file.
- **The deterministic parts are a Node script; the model does the judgment.**
  - `plugin/bin/sereno` (on the Bash tool's PATH while the plugin is enabled) is a small
    CLI written as `node`-runnable JS. On Windows the skills call
    `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" …`, never a shim.
  - It owns: config loading and validation; `review_run_id`; the base-commit worktree
    and test runs; comparing failures with the base; writing and validating gate and
    attempt JSON; brief file writes with the version check; and the bounded context
    request for the red team (named files, size-capped).
  - Skills orchestrate it and spawn the agents.
- **Tests run the way the repo says.** The test command comes from
  `.sereno/pipeline.json` `tests.command`, else `npm test` when `package.json` has a
  `test` script, else `/sereno:ship` stops and asks.
  - The base suite runs in a temporary `git worktree` of the base commit, never in your
    working copy. It runs before the head suite by default (`tests.parallel: true` runs
    them together; repos whose suites share ports or temp files should not). Its result
    is cached per base commit, so repeated `/sereno:ship` runs on one base reuse it. The
    worktree is removed afterwards.
  - A failure that already fails at base is not counted.
  - A suspected flaky failure, meaning one that fails at head but passes at base, is
    re-run once.
- **Recovery, exactly as the Builder spec says.**
  - Environment failure (missing tool or key, StopFailure or API error): retry up to
    `infraRetries`. It never uses the repair.
  - Defect (a regression against base, or a `block` for a bug, security issue or spec
    violation): one repair by the same Builder, then `/sereno:ship` again.
  - After a failed repair, `needs_context`, `error`, a budget stop or a turn-cap stop:
    stop and put one decision to you ("Review needs a decision"). The choices are
    clarify the spec, use a stronger Builder, or stop. Builder changes are never
    automatic.
- **Merge is yours.** `/sereno:ship` never pushes. On tests pass plus gate `pass` (or
  `skipped`), it shows the summary and asks before it merges the task branch locally
  with `--no-ff`. It merges only on a yes.
- **Files written to the repo,** all under `.sereno/`, formats exactly as in the spec:
  - `specs/<task>.md`
  - `gates/<review_run_id>.json`
  - `attempts/<task>-<n>.json`
  - `briefs/<branch>.md`
  The plugin never writes anywhere else in the repo except through the Builder's own
  code commits. Whether to commit `.sereno/` is the user's choice; the README says so.
- **Privacy.**
  - Gate findings are short summaries with a file and line, written by the red team. No
    diffs or code excerpts go into gate or attempt files.
  - Briefs keep their existing rules.
  - Nothing is sent anywhere except the normal Claude Code model calls.
- **Node.** The plugin needs Node 18+ on PATH. The README says so, and
  `sereno.js doctor` checks it.
- **The app's `/brief`.** It stays installable from the app in 4a. 4b makes the app
  offer the plugin and retire its own `/brief` (`/sereno:brief` uses the same format, so
  briefs written by either are read the same way).

## Exit criteria

Automated (`tools/test.js`, under `[plugin exit]`):
1. `claude plugin validate plugin` and `claude plugin validate .` pass. These run in CI
   only when `claude` is on PATH; otherwise a JSON-schema check of both manifests stands
   in.
2. A test that already fails at the base commit is not counted as a defect, and the base
   suite ran in its own worktree, not the working copy. Shown with a temp repo whose base
   already fails one test.
3. An environment failure retries without using the repair: the attempt records show
   `diagnosis: "environment"` and an unchanged repair count.
4. A second defect goes to the architect and raises "Review needs a decision": the gate
   and attempt files show it, and no third attempt starts.
5. Gate and attempt files match the spec's fields exactly, with unknown enum values
   stored as `unknown`, and validate against a schema. `config_hash` is stable for equal
   configs.
6. The plugin writes only under `.sereno/` in the repo (the script's file API refuses
   other paths) and never runs `git push`.

Manual (recorded in the plan's log by the architect):
7. One real task ships through the gate on each preset (`default`, `lean`), using a temp
   repo and `claude -p --plugin-dir plugin`. Passing tests are required before the merge
   prompt.

## Steps

### Step 0 — Repo scaffolding and manifests
- `plugin/.claude-plugin/plugin.json`: name `sereno`, version `0.1.0`, description,
  author, homepage, repository.
- `.claude-plugin/marketplace.json` at the repo root.
- `plugin/README.md`.
- `package.json` `build.files` must not pull `plugin/` into the Electron app.
- Tests: manifest shape, names, and that there is no `package.json` in `plugin/`.

### Step 1 — `sereno.js`: config, ids, file writers (pure where possible)
- `plugin/bin/sereno.js` with a subcommand router, no dependencies.
- Config load, merge and validation; `config_hash`.
- `review_run_id` format `rr_<UTC yyyymmddThhmmssZ>_<short head>`.
- Gate and attempt writers with schema validation and the `unknown` enum rule.
- A safe file API: realpath under `<repo>/.sereno/`, no symlink following, atomic
  writes.
- Exit codes and JSON output for skills to read.
- Tests: all of the above with temp repos.

### Step 2 — `sereno.js test`: base worktree and failure diff
- `sereno.js test --base <sha> --head <sha>` creates a temp worktree at base and runs
  the suite there, then at head. It runs them in parallel only with `tests.parallel`, and
  caches the base result per base commit under `.sereno/cache/`.
- Parse failures by test name where the runner prints them (a TAP-ish "not ok", or
  lines starting with "FAIL"/"✗"). Otherwise compare exit codes only, and say so.
- Re-run head-only failures once.
- Report JSON `{ passed, newFailures[], baseFailures[], flaky[], mode }`.
- Always remove the worktree, including on error.
- Uses the same git hardening as the app's `gitexec.js`, copied into the plugin. That
  copy is deliberate: the plugin must not depend on the app.
- Tests: exit criterion 2, plus a timeout, a missing test command, and cleanup on a
  crash.

### Step 3 — Agents and the `/sereno:task` + `/sereno:build` skills
- `plugin/agents/` holds builder, builder-haiku, builder-opus, scribe, red-team and
  red-team-lean. Each has `model`, `maxTurns` from the spec (40/80/120), `tools`, and a
  description. The red team is read-only, with tools Read, Grep, Glob and Bash (for git
  diff), and returns a verdict JSON in a fenced block.
- `/sereno:task <name>` makes the main session write `.sereno/specs/<task>.md` with
  front matter (`task`, `builder`, `kind`, `reason`, `fixes`, `spec_revision`) and the
  acceptance criteria, then creates branch `task/<name>`.
- `/sereno:build <task>` spawns the spec's Builder by agent name on that branch, writes
  the attempt record via `sereno.js`, and ends when the Builder has committed.
- Tests: frontmatter lint (models, maxTurns, tools; the red team has no Write or Edit);
  the skills reference only existing agents and `sereno.js` subcommands; spec template
  round trip.

### Step 4 — `/sereno:ship`: tests, review, gate, repair, merge prompt
- The skill, in order:
  1. `sereno.js test`
  2. on test pass, spawn the red team with the diff and spec
  3. `sereno.js gate` to validate the verdict and write the gate file
  4. apply the recovery rules
  5. `sereno.js attempt` to record the attempt
  6. the scribe refreshes the brief
  7. on pass, the merge prompt
- The red team's context requests go through `sereno.js context <files…>` (size-capped,
  inside the repo only).
- Fable unavailable means `onFallback`: "ask" offers `red-team-lean`; "auto" uses it and
  records that.
- Tests: exit criteria 3, 4 and 6 by driving `sereno.js` the way the skill does, with
  stubbed verdicts; the skill text references each step; no `git push` anywhere in
  `plugin/`.

### Step 5 — `/sereno:brief` and `sereno.js doctor`
- `/sereno:brief` uses the existing brief format via `sereno.js brief` (with the version
  check), and stays compatible with the app's parser (shared fixture test).
- `sereno.js doctor` checks Node, git, the test command, `pipeline.json` validity, and
  whether the `.sereno/` layout is writable.

### Step 6 — Docs, exit tests, e2e, release prep
- `[plugin exit]` tests 1–6.
- `plugin/README.md`: install, commands, presets, files written, privacy, Node
  requirement, how it relates to the app.
- The main README gets a short "Use the pipeline without the app" section.
- The architect runs the manual e2e (exit 7) on both presets and logs the results.
- Plugin version `0.1.0`; app `2.0.0-alpha.4`. The app is unchanged apart from docs, but
  the release carries the plugin.
- Red team on `main...feat/plugin-pipeline`, then ask before merge, push, tag and
  release.

## Out of scope for 4a

The app's Pipeline tab, role spend, pipeline alerts, reading attempts into the ledger,
the app offering to install the plugin, retiring the app's `/brief` (all 4b). Also: a
learned router, automatic Builder changes, per-invocation model switching, pushing, and
CI integration.
