# Sereno plugin

A gated build, review and ship pipeline for Claude Code, with a model per role. The
architect is your main session. A Builder (Haiku, Sonnet or Opus, chosen per task)
implements one task on its own branch and commits. A red team reviews the diff against
the spec and returns a verdict. `/sereno:ship` runs the tests against the base commit,
writes a gate file, repairs once for a defect, and stops. You merge with `/sereno:merge`.

It works without the Sereno app. It needs only Node and git. The Sereno app (Windows)
can observe the files it writes. Version 0.4.0. Windows is the first
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

## Typical flow

Write the specs, then let `/sereno:next` carry them. It runs every step that needs no human in one turn and stops at the first step that does, with one line saying what you do next.

```
/sereno:task add-export "Export the report as CSV"
/sereno:task export-ui "Add the export button" --after add-export
/sereno:next     builds and ships add-export, then stops:
                 "Gate passed for add-export. Before merging: <hold>. Run /sereno:merge add-export."
(do the human step, if there is one)
/sereno:merge add-export
/sereno:next     export-ui is no longer waiting: builds, ships, stops at its merge line
/sereno:merge export-ui
```

- **`--after <task>`** queues a task behind another. `/sereno:build` refuses it (`after_not_merged`) until that task is merged into the base. With no argument, `/sereno:next` takes the one task in progress, else the oldest spec that is ready; with two in progress it asks which.
- **`--hold "<one line>"`** on `/sereno:task` names a human step outside the pipeline, such as applying a migration to staging. `next` and `merge` print it before the merge. Typing `/sereno:merge` confirms it is done; the plugin never runs it.
- **Preflight.** `/sereno:build` runs the repo's pre-commit hook (`sereno.js preflight --task <name>`) after it has switched to `task/<name>` and before it starts the Builder; `preflight` itself never switches branches (it reports `on_task_branch` and `branch_note`). If the hook fails, the build stops before any Builder tokens are spent and shows the last lines of the output (`output_tail`). To go on past a hook failure, run `/sereno:next <name> approve-no-verify` (or `/sereno:build <name> approve-no-verify`): that approves `--no-verify` for that task's Builder commits and stores `no_verify_approved: true` in the attempt record; later attempts of the same task inherit it, and it ends when the task is merged or stopped. Without it the Builder never uses `--no-verify`.
- **No choice waits for a plain reply.** A plain reply starts a new turn on your session model and loses the skill's `sonnet`, so every skill that needs your decision ends its turn and prints the options as commands to run.
- **Squash merges done outside `/sereno:merge` are not detected.** Use `/sereno:merge`; if the branch was squash-merged and deleted by hand, run `sereno.js stop --task <name>` to retire the task.
- **A hook that refuses the Builder's commit** is recorded as `hook_failed`, and the work stays staged. Fix the hook on its own branch, or approve a commit that skips it, then run `sereno.js attempt --adopt --task <name>` to record that commit so ship can go on. Nothing skips a hook without your yes.
- `next` runs at most 3 build or ship steps per invocation, never merges and never touches a remote.

## The steps

The commands `/sereno:next` runs for you, and that you can also run one at a time.

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
switched off), it shows a summary and tells you to run `/sereno:merge <name>`. Ship never merges.

**`/sereno:merge <name>`** only you can start it, and typing it is the yes. It runs the recovery
rules again and merges only when the next step is `merge`: the latest attempt passed (or the
gate is off), the reviewed commit is still the tip of `task/<name>`, and the spec is unchanged.
With the red team on, that commit comes from the gate record, which must also belong to this task
and branch. With it off, it comes from the skipped attempt, which `/sereno:ship` stamps with the
tested head; a skipped attempt without one never merges. It then runs a local
`git merge --no-ff` of that exact commit (not the branch name) into the base branch and refreshes the
base branch brief. On conflicts it aborts the merge. It never touches a remote.

**`/sereno:brief`** writes the branch brief at `.sereno/briefs/<branch>.md`: three lines,
Now, Next and Blocked. It uses a version check, so a brief written by the app's `/brief`
or by this command is read the same way. Run it whenever you want the brief refreshed.

### Runnable checks

A spec can carry one `checks` fenced block under its acceptance criteria. `/sereno:task` writes it only for criteria that can be checked by running something, and never invents a command the repo does not have.

````
```checks
- cmd: npm run lint
  expect: exit 0
- serve: npm run dev
  ready: http://localhost:3000/health
- http: http://localhost:3000/api/items
  expect: status 200
- browse: http://localhost:3000/items
  look: the empty state says "No items yet"
```
````

- `sereno.js test --task <task>` runs the `cmd` and `http` checks at head, after the suite, in the repo root. A `cmd` has a 120 s limit; an `http` check is a GET with no redirects, a 10 s limit and the first 256 KiB of the body. A `serve` is started in the background, polled at `ready` for up to 60 s, and always stopped afterwards.
- A check that fails or times out is a new failure named `check <n>: <kind>`, so it leads to a repair like a failing test. Results are in the test output as `checks`; full logs go to `.sereno/cache/checks-<run>.log`.
- `browse` checks are not run by `test`. They are checked by the red team in a browser (below). A browse check that is not `pass` in the latest gate is printed at the merge stop with the hold, as "N browse checks unverified: check them yourself". Typing `/sereno:merge` is your yes.
- **Browse checks need a browser tool.** `sereno.js reviewer` picks `sereno:red-team-browse` whenever the spec has a `browse` check (a full review, never the light one). It inherits whichever browser MCP you have installed (Claude in Chrome or Playwright) and cannot write or edit files. It opens only the check's URL or same-origin pages reached from it, and never submits a form or signs in. If there is no browser tool it reports every browse check `unverified`, and they stay on the list for you to check before `/sereno:merge`. A `fail` makes the gate record `block`. `/sereno:ship` runs `sereno.js serve --task <task> --start` before that reviewer (the spec's `serve`, detached, polled at `ready`) and `--stop` after it on every path; `sereno.js doctor` reports a leftover server.
- URLs must be `http:` or `https:` on `localhost`, `127.0.0.1` or `[::1]`. Any other host must be named by you; `/sereno:task` then records it as `check_hosts` in the spec. A malformed block is refused with `invalid_checks`. The checks are pinned with the rest of the spec, so editing them after a build is a `spec_changed`.

## Roles and models

| Role | Agent | Tier | Turn cap |
|------|-------|------|----------|
| Architect, your session | main session (no agent) | your session's model | n/a |
| Orchestration (`task`, `next`, `build`, `ship`, `merge`, `brief`) | skills | sonnet | n/a |
| Builder, default | `sereno:builder` | sonnet | 80 |
| Builder, mechanical | `sereno:builder-haiku` | haiku | 40 |
| Builder, substantial | `sereno:builder-opus` | opus | 120 |
| Red team, `default` preset | `sereno:red-team` | fable | 60 |
| Red team, `lean` preset (and fallback) | `sereno:red-team-lean` | opus | 60 |
| Red team, spec with `browse` checks | `sereno:red-team-browse` | fable | 60 |
| Scribe (briefs, commit text) | `sereno:scribe` | haiku | 20 |

Models are tier aliases (`haiku`, `sonnet`, `opus`, `fable`) set in each agent file and, for orchestration, in each skill's front matter (`model: sonnet`, which applies to that turn only; your session model resumes on the next prompt). An alias tracks the current model of that tier on your provider. To repoint a tier, set `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` or `ANTHROPIC_DEFAULT_FABLE_MODEL` in your Claude Code settings. `roles.builder.allowed` restricts which Builder tiers a spec may choose, and the preset chooses the red team. The turn cap is fixed in each agent file. The
spec chooses the Builder per task, and that choice is never changed automatically.

**Cheapest setup:** start the session on Sonnet (`claude --model sonnet`) when you run the pipeline. A result that arrives in a later turn, such as a background agent or the ship test retry, runs on the session model, so on an Opus session it can cost an extra cold-cache Opus turn. In our small-task benchmark, Opus leaked this way in 2 of 3 `default` ships, adding about $0.44 each (an estimate).

## Cost: run agents in the foreground

`/sereno:next` is built to run its whole loop in one turn. When Claude Code runs subagents in the background, each agent result arrives as a new turn on your session model, with a cold cache, plus agent progress summaries. In a field test, switching this off cut a run from $5.45 to $2.92 (est.). Set `CLAUDE_CODE_FORK_SUBAGENT=0` (`sereno.js doctor` reports `background_subagents` as `on`, `off` or `unknown` from this variable and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). The plugin never writes your settings.

PowerShell, for the current session:

```
$env:CLAUDE_CODE_FORK_SUBAGENT = "0"
```

bash:

```
export CLAUDE_CODE_FORK_SUBAGENT=0
```

Or in `settings.json`, which applies to every Claude Code session:

```json
{ "env": { "CLAUDE_CODE_FORK_SUBAGENT": "0" } }
```

If an agent still runs in the background, the skills carry on from the step after it and never start a second Builder or red team for the same attempt.

## Presets and pipeline.json

Two presets:

- `default`: the red team is `red-team` on Fable. If Fable is unavailable,
  `onFallback: "ask"` stops and prints `/sereno:ship <task> use-fallback` (or `/sereno:next <task> use-fallback`) so you approve `red-team-lean` by re-running.
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
| `roles.builder.allowed` | `["haiku","sonnet","opus"]` | Builder tiers a spec may choose. Must include `roles.builder.default`. `sereno.js spec` refuses any other tier with `builder_not_allowed` (exit 21). Entries must be `haiku`, `sonnet` or `opus`. A pre-0.3.0 file that still sets `roles.builder.options.<tier>.model` loads, but the key is ignored (listed under `inert`; `doctor` notes it): models are tier aliases now, so repoint a tier with `ANTHROPIC_DEFAULT_<TIER>_MODEL` in Claude Code settings. |
| `roles.builder.options.<name>.maxTurns` | per option | Positive integer. Validated and recorded. The agent file's cap is the one that runs. Listed under `inert`. |
| `roles.scribe.agent` | `"scribe"` | Agent that writes briefs and commit text. |
| `roles.redTeam.agent` | `"red-team"` | Red team agent for `/sereno:ship`. |
| `roles.redTeam.fallback` | `"red-team-lean"` | Used when the red team's model is unavailable. `null` for none. |
| `roles.redTeam.onFallback` | `"ask"` | `"ask"` (stop and print the `use-fallback` command), `"auto"` or `"never"`. |
| `roles.redTeam.maxBlockedRuns` | `2` | Blocks in a row before the run asks you for a decision. |
| `roles.redTeam.enabled` | `true` | `false` switches the review off. The gate is then `skipped`. |
| `roles.redTeam.light` | off in `default`; `kinds: ["mechanical"]` in `lean` | A lighter reviewer for small plain tasks: `{ kinds, maxDiffLines: 80, agent: "red-team-lean", never: [] }`. `sereno.js reviewer` picks it only when the spec kind is listed, the diff is at most `maxDiffLines` lines and no touched path matches a `never` glob. `**/migrations/**`, `supabase/**` and any path containing auth, permission, payment, delete or secret always get the full red team; `never` can only add globs. The gate still has to pass. |
| `recovery.repairs` | `1` | Repairs allowed for a defect. |
| `recovery.infraRetries` | `2` | Retries allowed for an environment failure. |
| `recovery.taskBudgetUsd` | `null` | Validated (null or a positive number). No plugin script enforces it yet. Listed under `inert` when set. |
| `tests.command` | `null` | Test command. `null` uses `npm test` when `package.json` has a `test` script. Otherwise `/sereno:ship` asks. |
| `tests.setup` | `null` | Command run in the temporary base worktree before the base suite. |
| `tests.parallel` | `false` | `true` runs base and head together. Leave it `false` if the suites share ports or temp files. |
| `tests.timeoutSec` | `900` | Time limit for each suite run, in seconds. Suites up to 900 s are supported. `/sereno:ship` runs the tests in the foreground with a 540 s overall deadline; if the whole `test` call hits it, it runs the command once more in the background, at the cost of one extra turn on the session model, so only short suites stay on Sonnet the whole way. For a personal override use `~/.sereno/pipeline.json`, not the tracked file. |

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
- **Merge** happens only after you run `/sereno:merge`. `recovery` returns `merge` only if the gate
  reviewed the current tip of `task/<name>` (otherwise `review`, reason `head_moved`) and the spec
  is unchanged (otherwise `decide`, reason `spec_changed`).

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
Builder's commits on `task/<name>`, and, when you run `/sereno:merge`, the local `--no-ff` merge.
Nothing is ever sent to a remote.

Whether to commit `.sereno/` is your choice. Specs, gates and attempts make a useful
record. Either commit them on purpose, or add `.sereno/` to `.gitignore`. At the least
keep the generated parts out of git:

```
.sereno/cache/
.sereno/attempts/
```

`sereno.js test --deadline-sec <n>` sets one wall-clock budget for the whole call. When it runs out the script kills every running suite (the whole process tree), removes its temporary worktree, keeps a base cache only if the base suite already passed in full (never a partial one), prints `{"ok":false,"status":"deadline","code":"deadline",...}` and exits 20. The other exit codes are 2 usage, 3 config_invalid, 4 invalid_arg, 5 not_a_repo, 6 path_refused, 7 exists, 8 head_mismatch, 9 no_test_command, 10 worktree_failed, 11 dirty_tree, 12-19 record and spec refusals, 21 builder_not_allowed, and 130 interrupted. `/sereno:ship` passes 540 so the script stops before the Bash tool's 600 s cap.

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
- `/sereno:ship` and `/sereno:task` each write one file under `.sereno/cache/` (the
  verdict, the spec text) and ask Claude Code to pre-approve only that write. The skills write to the absolute `cacheDir` that `sereno.js paths` reports, spelled like the session's
  working directory so path casing can't trip the permission check. If you start
  Claude Code outside the repo root, or the pre-approval isn't applied, you are asked
  once. To approve it for good, add `Edit(/.sereno/cache/**)` to the project's
  `.claude/settings.json` `permissions.allow` (there a leading `/` anchors at the
  project root).

## Using Sereno with other plugins

Sereno works alongside process plugins such as Superpowers. While a `/sereno:` step runs,
Sereno is the process, and its skills tell the session not to start other plugins' skills.
Builders have no Skill tool, so they cannot start worktrees, reviews or merges. They also
have no web, notebook or MCP tools: write specs that a Builder can follow from the repo
alone. Other plugins' skills stay useful outside the pipeline.

## The Sereno app

The app (2.0.0-alpha.6 and later) reads briefs in its Projects tab, and the gate and
attempt files in its Pipeline tab. It shows the install commands when the plugin is
missing. The app's old `/brief` command is retired; use `/sereno:brief`.
