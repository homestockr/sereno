# Sereno plugin

A gated build, review and ship pipeline for Claude Code, with a model per role. The
architect is your main session. A Builder (Haiku, Sonnet or Opus, chosen per task)
implements one task on its own branch and commits. A red team reviews the diff against
the spec and returns a verdict. `/sereno:ship` runs the tests against the base commit,
writes a gate file, repairs once for a defect, and asks you before it merges anything.

It works without the Sereno app. It needs only Node and git. The Sereno app (Windows)
can observe the files it writes. Version 0.1.0, in development. Windows is the first
platform; other systems are not yet tested.

## Install

```
/plugin marketplace add homestockr/sereno
/plugin install sereno@sereno
```

To update, run `claude plugin update sereno@sereno` (or use `/plugin`), then
`/reload-plugins` in any open session. The manifest pins `version`, so you move only
when a release changes it. Claude Code turns auto-update on by default only for Anthropic's own marketplaces, so for this one it is off unless you enable it in /plugin › Marketplaces.

To turn it off or remove it:

```
claude plugin disable sereno
claude plugin uninstall sereno
```

Requirements: Node 18 or newer and git, both on PATH. On Windows you also need Git for
Windows, which provides Git Bash; Claude Code's Bash tool runs on it. The plugin's commands
are bash (quoting, heredocs), and the skills run them only with the Bash tool. To check your setup, run
`node "<plugin>/bin/sereno.js" doctor` from the repo you work in. It prints one JSON
object with a check per item (Node, git, the repo, `pipeline.json`, the test command, the
`.sereno/` layout, and the red-team agents) and exits non-zero if any check fails.
The skills do not run it for you.

## The flow

Run the commands in this order for each task.

**`/sereno:task <name> [goal]`** writes the task spec at `.sereno/specs/<name>.md`. The
spec holds the acceptance criteria, what is out of scope, the tests required, and the
Builder chosen with its reason. It creates the branch `task/<name>` from your current
branch and records that branch as the merge target. Run it again on the same name to
revise the spec.

**`/sereno:build <name>`** switches to `task/<name>` and runs the Builder the spec names.
The Builder implements only the spec, adds its tests, and commits. The attempt is
recorded in `.sereno/attempts/`. It never sends commits to a remote.

**`/sereno:ship <name>`** runs the tests at the base commit and at the head. It sends
the diff and spec to the red team, writes the verdict to `.sereno/gates/`, and applies
the recovery rules below. When tests pass and the gate passes (or the red team is
switched off), it shows a summary and asks whether to merge `task/<name>` into the base
branch with `--no-ff`. It merges only on a yes.

**`/sereno:brief`** writes the branch brief at `.sereno/briefs/<branch>.md`: three lines,
Now, Next and Blocked. It uses a version check, so a brief written by the app's `/brief`
or by this command is read the same way. Run it whenever you want the brief refreshed.

## Roles and models

| Role | Agent | Model | Turn cap |
|------|-------|-------|----------|
| Architect | main session (no agent) | your session's model | n/a |
| Builder, default | `sereno:builder` | claude-sonnet-5-5 | 80 |
| Builder, mechanical | `sereno:builder-haiku` | claude-haiku-4-5-20251001 | 40 |
| Builder, substantial | `sereno:builder-opus` | claude-opus-5-5 | 120 |
| Red team, `default` preset | `sereno:red-team` | claude-fable-5-1 | 60 |
| Red team, `lean` preset (and fallback) | `sereno:red-team-lean` | claude-opus-5-5 | 60 |
| Scribe (briefs, commit text) | `sereno:scribe` | claude-haiku-4-5-20251001 | 20 |

The model and turn cap are fixed in each agent file. Config cannot change them. The
spec chooses the Builder per task, and that choice is never changed automatically.

## Presets and pipeline.json

Two presets:

- `default`: the red team is `red-team` on Fable. If Fable is unavailable,
  `onFallback: "ask"` offers `red-team-lean` instead.
- `lean`: the red team is `red-team-lean` on Opus, with no fallback.

Both presets use the same Builders.

The config is read from the first file that exists:

1. `.sereno/pipeline.json` in the repo
2. `~/.sereno/pipeline.json`
3. the built-in `default` preset

Keys you set are merged over the preset. Keys you leave out keep their defaults.
`node "<plugin>/bin/sereno.js" config` prints the effective config and its hash. An
invalid file stops the pipeline and lists the errors.

| Key | Default | What it does |
|-----|---------|--------------|
| `preset` | `"default"` | `"default"` or `"lean"`. |
| `roles.builder.default` | `"sonnet"` | Default Builder option: `haiku`, `sonnet` or `opus`. |
| `roles.builder.options.<name>.agent` | per option | Agent name; must be a plugin agent. Validated and recorded. |
| `roles.builder.options.<name>.model` | per option | Model id. Validated and recorded. The agent file's model is the one that runs. Listed under `inert` by `config` and noted by `doctor`. |
| `roles.builder.options.<name>.maxTurns` | per option | Positive integer. Validated and recorded. The agent file's cap is the one that runs. Listed under `inert`. |
| `roles.scribe.agent` | `"scribe"` | Agent that writes briefs and commit text. |
| `roles.redTeam.agent` | `"red-team"` | Red team agent for `/sereno:ship`. |
| `roles.redTeam.fallback` | `"red-team-lean"` | Used when the red team's model is unavailable. `null` for none. |
| `roles.redTeam.onFallback` | `"ask"` | `"ask"`, `"auto"` or `"never"`. |
| `roles.redTeam.maxBlockedRuns` | `2` | Blocks in a row before the run asks you for a decision. |
| `roles.redTeam.enabled` | `true` | `false` switches the review off. The gate is then `skipped`. |
| `recovery.repairs` | `1` | Repairs allowed for a defect. |
| `recovery.infraRetries` | `2` | Retries allowed for an environment failure. |
| `recovery.taskBudgetUsd` | `null` | Validated (null or a positive number). No plugin script enforces it yet. Listed under `inert` when set. |
| `tests.command` | `null` | Test command. `null` uses `npm test` when `package.json` has a `test` script. Otherwise `/sereno:ship` asks. |
| `tests.setup` | `null` | Command run in the temporary base worktree before the base suite. |
| `tests.parallel` | `false` | `true` runs base and head together. Leave it `false` if the suites share ports or temp files. |
| `tests.timeoutSec` | `900` | Time limit for each suite run, in seconds. `/sereno:ship` runs the tests in the background, so this can exceed the Bash tool's 600 s foreground cap. For a personal override use `~/.sereno/pipeline.json`, not the tracked file. |

A minimal example:

```json
{
  "preset": "lean",
  "tests": { "command": "npm test", "timeoutSec": 600 }
}
```

## Recovery

- **Environment failure** (a missing tool or key, a StopFailure, an API error): retry
  up to `infraRetries` times. A retry never uses the repair.
- **Defect** (a test that fails at head but passes at base, or a red-team block for a
  bug, security, privacy, test or spec violation): one repair by the same Builder, then
  `/sereno:ship` runs again.
- **Anything else** (a second defect after the repair, `needs_context`, `error`, a budget
  or turn-cap stop, or too many blocks in a row): the run stops and puts one decision to
  you, "Review needs a decision". The choices are: clarify the spec, use a stronger
  Builder, or stop. Builders are never changed automatically.

## What it writes

Everything the plugin writes goes under `.sereno/` in your repo:

- `specs/<task>.md`: the task spec.
- `gates/<review_run_id>.json`: the red team's verdict, validated. Findings are short
  summaries with a file and line.
- `attempts/<task>-<n>.json`: one record per Builder run.
- `briefs/<branch>.md`: the branch brief.
- `cache/`: the base test result for each base commit, and the test logs. The logs hold
  whatever your test output prints, so keep `.sereno/cache/` out of git. It also holds two
  transient hand-off files, `verdict-<review_run_id>.json` and `spec-<task>.md`, which
  `/sereno:ship` and `/sereno:task` write and the plugin deletes as soon as it has used them.

It also runs the base suite in a temporary git worktree in the system temp directory,
and removes that worktree afterwards. When `tests.setup` is unset, the base worktree gets
a link (a junction on Windows) to the head working tree's `node_modules`, so the base run
uses your installed dependencies. Checking out the base commit applies the repo's
`.gitattributes` filters using your own git config; that is the same trust as running
your test command. `git worktree` calls get their own timeout, `tests.worktreeTimeoutSec`
(default 300); both it and `tests.timeoutSec` are capped at 2147483. Git changes are limited to creating `task/<name>`, switching between branches, the
Builder's commits on `task/<name>`, and, after your yes, the local `--no-ff` merge.
Nothing is ever sent to a remote.

Whether to commit `.sereno/` is your choice. Specs, gates and attempts make a useful
record. Either commit them on purpose, or add `.sereno/` to `.gitignore`. At the least
keep the generated parts out of git:

```
.sereno/cache/
.sereno/attempts/
```

A failing head is passed only when it provably completed: it printed a TAP plan (`1..N`) that was reached, or a TAP summary (`# tests N`, plus `# pass`/`# fail` when printed) that matches the result lines seen, as `node --test --test-reporter=tap` and tape do. Without either (no plan or summary, or a non-TAP runner), `sereno.js test` reports `unknown_baseline` ("cannot confirm the head suite completed") and the run goes to a decision; a head that exits 0 still passes. On every path (named failures or exit-code mode), a head re-run that exits 0 only excuses flaky failures if it printed at least as many results as the first run and the base.

The clean-tree check (`sereno.js clean`, also used inside `sereno.js test` and `branch`, and by the build and ship
skills) runs at the repo root and ignores only the generated dirs `.sereno/attempts`, `gates`, `briefs` and `cache`. A change to a
tracked `.sereno/pipeline.json` or `.sereno/specs/` blocks a run. `/sereno:build` pins the spec's sha256 in the attempt; `test` and `gate` refuse with `spec_changed` if the spec differs.

**Recovery and tests.** The head suite is only trusted to have finished if its TAP output holds up: no repeated test numbers, and a plan line printed last is the last TAP line with no results after it. A test that deliberately prints fake TAP lines can still mislead the count; the red team reviews the diff for that. `sereno.js test` also removes stale `sereno-base-*` temp dirs (older than an hour, made by this plugin) before it starts.
Failing test names are read from TAP (`not ok`), `FAIL`, and the markers `✗`, `✕` and `✖`, with a trailing duration such as `(3 ms)` removed. For `node --test`, `--test-reporter=tap` is the most precise option (for example `"command": "node --test --test-reporter=tap"`).
If you delete tests while a base failure persists, the head's result count falls below the base's and `/sereno:ship` stops at "Review needs a decision" (never a wrong pass). The same happens with a test command that chains two TAP producers, because the repeated test numbers are not trusted as evidence.
Once any attempt of a task has pinned a spec, creating another attempt needs `--spec` (`spec_required`), and `test` and `gate` need `--task` on a task branch (`task_required`).
The Builder agents are told to stage only the files they changed and never `.sereno/`.

## Privacy and trust

- Gate and attempt files hold short findings, not code. No diffs or code excerpts are
  written to them.
- The red team is told to be read-only: no writes, no installs, and Bash only for
  read-only git. That is an instruction to the agent, not a sandbox. Its tool list
  grants Bash, so a red team that ignores its instructions could run other commands.
- Test commands from your repo run on your machine, through a shell, with your
  permissions. Read `tests.command` and `tests.setup` before you ship.
- Nothing is sent anywhere except the normal Claude Code model calls. The plugin never
  contacts a git remote.

## The Sereno app

The app reads briefs in its Projects tab. The gate and attempt files are written now.
The app's Pipeline view that reads them is planned for the next phase. Until then, the
app's `/brief` command still works, and it writes the same brief format.
