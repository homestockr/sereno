---
name: next
description: Run every pipeline step that needs no human (build, ship, retry) for the next task, and stop at the first step that does. Use instead of typing build and ship by hand.
argument-hint: [task]
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent, Write(.sereno/cache/verdict-*.json)
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written. Run every command and every agent in the foreground and wait for it in this turn: a background result arrives as a new turn on the session model with a cold cache. Never use `run_in_background`. For a long command such as the test run, pass a Bash `timeout` of 600000.

You are the architect for the whole run. You ask what comes next, do the steps that need no human, in this one turn, and stop at the first step that does. You do not write feature code and you do not review the diff yourself.

Arguments: `$ARGUMENTS`. The first word is the task name unless it is a flag word; a flag word (`approve-no-verify`, `use-fallback`) is never a task name, so `/sereno:next approve-no-verify` means no task plus that flag. With no task, the script picks the task. Flags: `approve-no-verify` approves `--no-verify` for this task's Builder commit, for as long as the task lasts (until merge or stop), and only when a hook failure is the reason; `use-fallback` approves the fallback red team for this run (ship step 2). Pass `approve-no-verify` to the build skill and `use-fallback` to the ship skill, and nothing else. Any other word: stop and show the usage `/sereno:next [task] [approve-no-verify] [use-fallback]`.

A plain reply from the user starts a new turn on the session model and loses this skill's model, so a choice never waits for an answer in this turn: end the turn and print each option as a command to re-run.

This skill is the process for this run. Don't invoke other plugins' skills (planning, worktrees, code review, branch finishing) while it runs. The Sereno agents it names, such as the red team, are part of the process.

Background agents: if an agent was started in the background anyway and its result arrives in a later turn, first finish that agent's own step (for a Builder, build steps 5 and 6: check the result and update the attempt record; for the red team, ship steps 3 and 4), and only then continue from the step after that agent. Use the attempt record (`.sereno/attempts/<task>-<n>.json`) and `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" next --task <task>` to find where you are. Never start a second Builder or red team for the same attempt (`attempt` refuses a new running record while the newest one is still running).

Rules that hold throughout: never merge (merging is `/sereno:merge`, which only the user can start) and never run anything against a remote. Every script result is one JSON object; if `ok` is false, show the `error` and stop.

## 1. Ask what is next

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" next [--task <task>] --steps-done <n>
```

Pass `--task` only when the user gave a task. `<n>` is the number of build / ship / repair / retry steps you have done so far in this run (0 the first time). The result has `task`, `step`, `reason`, `hold`, `command` (and `tasks` for `pick`). Act on `step`.

## 2. The commit-hook check

The build skill runs the repo's commit-hook check itself, after it has switched to `task/<task>` and before the Builder starts (its step 2). Do not run `preflight` here: it never switches branches, and this skill is not on the task branch yet. If a failing hook stops the build, the build skill prints the options as commands (fix the hook and run `/sereno:next <task>` again, or `/sereno:next <task> approve-no-verify`); print that as the final line and stop.

## 3. Do the step

- `spec_review`: the red team reads the spec before the first build. It is not a build, ship, repair or retry step, so it does not count toward the cap below. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" paths` for `cacheDir`, and `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" config` for `roles.redTeam.agent`. Spawn that red team with the Agent tool in the foreground (`subagent_type` `sereno:` plus the agent name, no `model`), with the prompt "spec review of .sereno/specs/<task>.md; answer with the spec review verdict JSON". Take the one fenced json block from its answer (`outcome` and `points`) and write it, with Write, to `<cacheDir>/verdict-spec-<task>.json`. Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" spec-review --file <cacheDir>/verdict-spec-<task>.json --task <task> --session "${CLAUDE_SESSION_ID}" --agent-name <red-team or red-team-lean, whichever reviewed> --agent <agent id from the Agent tool result>
```

  Then go back to step 1: an `agree` leads to `build`; `revise` or `split` leads to a `decide` stop. If the agent fails, gives no verdict block, or `spec-review` refuses it, do not retry and do not ask again (that would loop): print the error and "Run /sereno:build <task> to build without the spec review." as the final line, and stop.
- `build`: read `${CLAUDE_PLUGIN_ROOT}/skills/build/SKILL.md` and follow it for the task (with `approve-no-verify` if the user gave it), then go back to step 1.
- `ship`, `repair` or `retry`: read `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` and follow it for the task (with `use-fallback` if the user gave it; it includes its one repair), then go back to step 1. If ship ends at "Review needs a decision" or at its merge prompt, do not repeat that message: go back to step 1 and let the next result be the single stop line.

Which ship step to enter: for `step: "retry"` (an environment failure) and for `step: "repair"` (one repair is due: a defect), go straight to the `retry` / `repair` bullet in ship's step 5 and skip its steps 1 to 4: the latest attempt is final, so nothing is left to test or review yet. Key on `step` only, never on the wording of `reason`. A `ship` step for a built attempt starts at ship's step 1.

For `ship`, `retry` and `repair`, if you are not on `task/<task>`: run `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean` first; if it is not clean, print the `files` and stop. Otherwise run `git switch task/<task>`. Never switch to the base branch.

If the build or ship skill stops before it writes or updates an attempt record (a precondition refusal), or says to run another command, print that line as the final line and stop. Do not ask `next` again.

Follow those skills as written, in the foreground, in this same turn. After a step completed and recorded its attempt, where the skill says to tell the user to run the next command, do not stop for that: the loop here runs it.

Safety cap: run at most 3 `build` / `ship` / `repair` / `retry` steps in one invocation. This is a backstop, not a hard limit: you count the steps yourself and pass the count, so keep it carefully. Keep a count of the steps you have done and pass it every time you ask what is next: `next ... --steps-done <n>`. When the result has `cap_reached: true`, stop without starting another step, report the current state in one line (the latest `reason`) and tell the user to run `/sereno:next` again.

## 4. Stop

Stop at the first step that is not `spec_review`, `build`, `ship`, `repair` or `retry`. Print exactly one final line:

- `merge`: "Gate passed for <task>. Before merging: <hold>. Run /sereno:merge <task>." Leave out the "Before merging" sentence when `hold` is null. When the result has `browse_unverified`, add the result's `browse_note` and one line per entry, "<url>: <look>".
- `decide`: the `reason`, then the `command` if there is one (its options are a person's call, so list them if the reason does). When the reason says the branch is gone, tell the user the whole reason line (it names both options, one of them the `stop` command); never run `stop` yourself.
- `done` or `idle`: the `reason`, then "Nothing queued." (skip it when the reason already says so) or, when another task is waiting, that task's name.
- `pick`: list the tasks, each as a command to run (`/sereno:next <task>`), then end the turn. Do not guess and do not wait for an answer.

Do not merge, switch to the base branch, or touch a remote.
