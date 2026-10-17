---
name: merge
description: Merge a shipped task branch into its base branch locally. Use after /sereno:ship says it is ready.
argument-hint: <task>
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent(sereno:scribe)
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written. Run every command and every agent in the foreground and wait for it in this turn: a background result arrives as a new turn on the session model with a cold cache. Never use `run_in_background`. For a long command such as the test run, pass a Bash `timeout` of 600000.

Typing `/sereno:merge` is the user's explicit yes. You merge one task branch into its base
branch with a local `--no-ff` merge, and nothing else. You do not write feature code and you
do not review anything.

Arguments: `$ARGUMENTS`. The first word is the task name. If it is missing, ask for it.

Rules that hold throughout: never run anything against a remote. Every script result is one
JSON object; if `ok` is false, show the `error` and stop.

## 1. Check the rules

- Read `.sereno/specs/<task>.md`. Take `base_branch` from its front matter. If it is null
  or missing, ask the user which branch this task merges into.
- Ask the rules what is next:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" recovery --task <task>
```

Merge only when `next` is `merge`. `recovery` returns `merge` only when the latest attempt
passed (or was skipped because the gate is off), the reviewed commit is still the tip of
`task/<task>`, the gate belongs to this task and branch, and the spec is the one that was
reviewed. Take `head_commit` from the result: that is the commit you merge. For any other `next`,
show the `reason` in one line and stop. Tell the user what to run: if the reason starts with
`head_moved`, `/sereno:build <task>`; if it starts with `spec_changed`, `/sereno:task <task>`;
for anything else, `/sereno:ship <task>`.

## 2. Clean tree

You are on any branch, but there must be no uncommitted changes to tracked files
(`node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean` returns `clean: true`; only the generated `.sereno/` dirs are ignored). If not, stop and say so.

## 3. Merge

Immediately before merging, check that `git rev-parse refs/heads/task/<task>` equals
`head_commit`. If it does not, stop and say the branch moved. Then merge the reviewed commit,
not the branch name:

```
git switch <base_branch>
git merge --no-ff -m "Merge branch 'task/<task>'" <head_commit>
```

If the merge reports conflicts, run `git merge --abort`, tell the user, and stop. Never add
a remote step.

## 4. Brief

After the merge, ask `sereno:scribe` to refresh the brief for `<base_branch>`. Agents cannot
expand `${CLAUDE_PLUGIN_ROOT}`, so give the scribe the literal command line in its prompt,
with only the angle-bracket values left for it to fill, and tell it to run that command
verbatim and never construct a path itself:

```
Run exactly: node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" brief --branch <base_branch> --now "<now>" --next "<next>" --blocked "<blocked>" --expect-version <version it read from the existing brief, 0 if none>
```

Report the merge commit in one line.
