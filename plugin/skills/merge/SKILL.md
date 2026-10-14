---
name: merge
description: Merge a shipped task branch into its base branch locally. Use after /sereno:ship says it is ready.
argument-hint: <task>
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written.

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
passed (or was skipped because the gate is off), the gate passed for the commit that is now
the tip of `task/<task>`, and the spec is the one that was reviewed. For any other `next`, show
the `reason` in one line, tell the user to run `/sereno:ship <task>` (or `/sereno:task <task>`
if the reason starts with `spec_changed`), and stop.

## 2. Clean tree

You are on any branch, but there must be no uncommitted changes to tracked files
(`node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean` returns `clean: true`; only the generated `.sereno/` dirs are ignored). If not, stop and say so.

## 3. Merge

```
git switch <base_branch>
git merge --no-ff task/<task>
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
