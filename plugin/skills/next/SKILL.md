---
name: next
description: Run every pipeline step that needs no human (build, ship, retry) for the next task, and stop at the first step that does. Use instead of typing build and ship by hand.
argument-hint: [task]
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent, Edit(.sereno/cache/verdict-*.json)
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written. Run every command and every agent in the foreground and wait for it in this turn: a background result arrives as a new turn on the session model with a cold cache. Never use `run_in_background`. For a long command such as the test run, pass a Bash `timeout` of 600000.

You are the architect for the whole run. You ask what comes next, do the steps that need no human, in this one turn, and stop at the first step that does. You do not write feature code and you do not review the diff yourself.

Arguments: `$ARGUMENTS`. The first word, if there is one, is the task name. With none, the script picks the task.

This skill is the process for this run. Don't invoke other plugins' skills (planning, worktrees, code review, branch finishing) while it runs. The Sereno agents it names, such as the red team, are part of the process.

Rules that hold throughout: never merge (merging is `/sereno:merge`, which only the user can start) and never run anything against a remote. Every script result is one JSON object; if `ok` is false, show the `error` and stop.

## 1. Ask what is next

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" next [--task <task>]
```

Pass `--task` only when the user gave a task. The result has `task`, `step`, `reason`, `hold`, `command` (and `tasks` for `pick`). Act on `step`.

## 2. Before the first build of a task

Before the first `build` step of a task in this run, run the repo's commit-hook check:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" preflight
```

If `passed` is false, stop with one line naming the `hook` and the first line of `output_head`, then the two options: fix the hook on its own branch, or approve a commit that uses `--no-verify` for this task's commit. Never skip a hook yourself, and do not start the Builder. If `dirty_after` is true, say the hook changed files in the working tree and leave them as they are.

## 3. Do the step

- `build`: read `${CLAUDE_PLUGIN_ROOT}/skills/build/SKILL.md` and follow it for the task, then go back to step 1.
- `ship` or `retry`: read `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` and follow it for the task (it includes its one repair), then go back to step 1. If ship ends at "Review needs a decision" or at its merge prompt, do not repeat that message: go back to step 1 and let the next result be the single stop line.

Follow those skills as written, in the foreground, in this same turn. Where they say to tell the user to run the next command, do not stop for that: the loop here runs it.

Safety cap: run at most 3 `build` / `ship` / `retry` steps in one invocation. After the third, stop and report the current state in one line (the latest `reason`) and tell the user to run `/sereno:next` again.

## 4. Stop

Stop at the first step that is not `build`, `ship` or `retry`. Print exactly one final line:

- `merge`: "Gate passed for <task>. Before merging: <hold>. Run /sereno:merge <task>." Leave out the "Before merging" sentence when `hold` is null.
- `decide`: the `reason`, then the `command` if there is one (its options are a person's call, so list them if the reason does).
- `done` or `idle`: the `reason`, then "Nothing queued." (skip it when the reason already says so) or, when another task is waiting, that task's name.
- `pick`: list the tasks and ask which one to run, then stop. Do not guess.

Do not merge, switch to the base branch, or touch a remote.
