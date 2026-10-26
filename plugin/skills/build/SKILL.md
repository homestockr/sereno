---
name: build
description: Run the spec's Builder on the task branch and record the attempt. Use after /sereno:task.
argument-hint: <task>
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written. Run every command and every agent in the foreground and wait for it in this turn: a background result arrives as a new turn on the session model with a cold cache. Never use `run_in_background`. For a long command such as the test run, pass a Bash `timeout` of 600000.

You are the architect. You run the Builder the spec names and record what happened.
You do not write the feature code yourself.

Arguments: `$ARGUMENTS`. The first word is the task name; any other words are flags. If the task is missing, stop and show the usage `/sereno:build <task> [approve-no-verify]`. The one flag is `approve-no-verify`: the user approves `--no-verify` for this task's Builder commit only, and only when a hook failure (preflight or `hook_failed`) is the reason. Any other word: stop and show the usage. The approval lasts for the task: a later attempt of the same task inherits it (see step 3), until the task is merged or stopped.

A plain reply from the user starts a new turn on the session model and loses this skill's model, so a choice never waits for an answer in this turn: end the turn and print each option as a command to re-run.

Background agents: if an agent was started in the background anyway and its result arrives in a later turn, first finish that agent's own step (for the Builder, steps 5 and 6 below: check the result and update the attempt record from it), and only then continue from the step after that agent. Use the attempt record (`.sereno/attempts/<task>-<n>.json`) and `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" next --task <task>` to find where you are. Never start a second Builder or red team for the same attempt (`attempt` refuses a new running record while the newest one is still running).

This skill is the process for this run. Don't invoke other plugins' skills (planning, worktrees, code review, branch finishing) while it runs. The Sereno agents it names, such as the red team, are part of the process.

## 1. Read the spec

Read `.sereno/specs/<task>.md`. From its front matter take `builder` (`haiku`,
`sonnet` or `opus`), `kind`, `fixes` (or null) and `spec_revision`. If the file is
missing or `builder` is not one of those three, stop and tell the user to run
`/sereno:task` first.

Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" after-check --task <task>`. If the spec has an
`after` task that is not merged into the base yet, it returns `ok: false` with code
`after_not_merged`: show the `error` and stop. Do not start the Builder, write an attempt or work around it.

## 2. Get on the task branch

The working tree must have no uncommitted changes to tracked files. Check with
`node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean` (it runs at the repo root, whatever your directory, and ignores only the generated dirs `.sereno/attempts`, `gates`, `briefs` and `cache`); if `clean` is false, stop and list `files`.
Then run `git switch task/<task>`. If the branch does not exist, stop and point to
`/sereno:task`. Note the starting commit: `git rev-parse HEAD`, and the time (UTC,
ISO 8601).

Now, on the task branch and before any attempt record or Builder, check that the repo's commit hook would accept a commit:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" preflight --task <task>
```

`preflight` never switches branches; if `on_task_branch` is false, mention `branch_note` in one clause. If `passed` is false, show the `hook`, the `output_tail` lines (the real failure is at the end; `output_head` is only the start) and any `branch_note`. Without `approve-no-verify`, stop here: write no attempt record, start no Builder, and end the turn printing the options as commands: fix the hook on its own branch and run `/sereno:build <task>` again, or `/sereno:build <task> approve-no-verify` to approve `--no-verify` for this task's Builder commit. With `approve-no-verify`, carry on. If `dirty_after` is true, the hook changed files: stop, list them, and tell the user to review or discard them and run the build again. Never skip a hook yourself.

## 3. Record the attempt before the Builder starts

One Builder run is one attempt record. Write it now, as `running`, so an interrupted run
still leaves a trace:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" attempt --task <task> --spec-revision <spec_revision> --builder <builder> --kind <kind> [--fixes <fixes>] --diagnosis none --outcome running --started-at <start> --start-commit <starting commit> --spec .sereno/specs/<task>.md [--no-verify-approved]
```

Add `--no-verify-approved` when the user gave `approve-no-verify`: it stores `no_verify_approved: true` in the record so the approval is auditable. A new record also inherits it from the task's newest earlier attempt, so a later attempt of the same task keeps the approval without the flag (a stopped task starts fresh).

`--start-commit` records the commit the Builder starts from; `--adopt` later uses it to tell a new commit from an old one. `--spec` pins the spec: it records the sha256 of the spec file as `spec_hash`, and the later test and gate steps refuse with `spec_changed` if the spec is edited afterwards. Add `--fixes` only when the spec has one. The result is `{ ok, path, attempt }`; keep the
`attempt` number. If `ok` is false, show the error and stop.

## 4. Spawn the Builder

Map the spec's `builder` to an agent by name and call the Agent tool with
`subagent_type` set to it. Do not pass a `model` parameter; the agent sets its own model tier.

| spec `builder` | agent |
|----------------|-------|
| `sonnet` | `sereno:builder` |
| `haiku`  | `sereno:builder-haiku` |
| `opus`   | `sereno:builder-opus` |

Prompt: "Implement the task spec at `.sereno/specs/<task>.md` on the current branch
`task/<task>`. When finished, commit, and report files changed, tests run and result."
If `fixes` is set, or this is a repair run with review findings, include those findings
in the prompt and tell the Builder to fix only them.

Without the approval (the flag, or `no_verify_approved: true` in the record you just wrote), the Builder must not use `--no-verify`. With it, add to the prompt: "The user approved `--no-verify` for this task's commit. Commit normally first; use `git commit --no-verify` only if a hook refuses it, and say so in your report."

## 5. Check the result

When the Builder returns, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean`,
`git rev-parse HEAD` and `git branch --show-current`. It succeeded only if HEAD moved
from the starting commit, `clean` is true and the current branch
is still `task/<task>`. If the branch is anything else, the outcome is `error`: say so
in the note and do not switch branches yourself. If it did not commit, or left changes behind, do not commit for it: the
outcome is `error`.

## 6. Update the attempt

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" attempt --task <task> --update <attempt> --outcome <built|error> --diagnosis <none|environment> --agent-id <Builder agent id from the Agent tool result> --ended-at now
```

Omit `--agent-id` if the Agent tool result gave none. Use `--outcome built` when the Builder committed (it now waits for review; `/sereno:ship`
records the final outcome). Use `--outcome error` when it did not commit or the run
failed. For `error`, use `--diagnosis environment` if the cause was the environment (a
StopFailure, an API or rate-limit error, a missing tool or key), and `--diagnosis none`
otherwise, including a turn or budget stop. If the Builder reports that `git commit` was refused by
a repo hook (it will have left its work staged and quoted the first lines of the hook output), record
`--outcome error --diagnosis hook_failed`, show those lines, and tell the user: fix the hook on its own
branch and run `/sereno:build <task>` again, or approve `--no-verify` for the Builder's commit with `/sereno:build <task> approve-no-verify` (or commit by hand and run
`node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" attempt --adopt --task <task>`). Print those as commands and end the turn. Never skip a hook yourself. The result is `{ ok, path, attempt }`; if
`ok` is false, show the error.

## 7. Stop

End with a few lines: the Builder used, the commit, and the Builder's own report in
one line. Tell the user to run `/sereno:ship <task>` next. Do not run tests, review the
diff, merge or switch branches again.
