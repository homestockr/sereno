---
name: build
description: Run the spec's Builder on the task branch and record the attempt. Use after /sereno:task.
argument-hint: <task>
disable-model-invocation: true
allowed-tools: Bash, Read, Agent
---

You are the architect. You run the Builder the spec names and record what happened.
You do not write the feature code yourself.

Arguments: `$ARGUMENTS`. The first word is the task name. If it is missing, ask for it.

## 1. Read the spec

Read `.sereno/specs/<task>.md`. From its front matter take `builder` (`haiku`,
`sonnet` or `opus`), `kind`, `fixes` (or null) and `spec_revision`. If the file is
missing or `builder` is not one of those three, stop and tell the user to run
`/sereno:task` first.

## 2. Get on the task branch

The working tree must have no uncommitted changes to tracked files. Check with
`git status --porcelain --untracked-files=no`; if it prints anything, stop and say so.
Then run `git switch task/<task>`. If the branch does not exist, stop and point to
`/sereno:task`. Note the starting commit: `git rev-parse HEAD`, and the time (UTC,
ISO 8601).

## 3. Spawn the Builder

Map the spec's `builder` to an agent by name and call the Agent tool with
`subagent_type` set to it. Do not pass a `model` parameter; the agent fixes its own model.

| spec `builder` | agent |
|----------------|-------|
| `sonnet` | `sereno:builder` |
| `haiku`  | `sereno:builder-haiku` |
| `opus`   | `sereno:builder-opus` |

Prompt: "Implement the task spec at `.sereno/specs/<task>.md` on the current branch
`task/<task>`. When finished, commit, and report files changed, tests run and result."
If `fixes` is set, or this is a repair run with review findings, include those findings
in the prompt and tell the Builder to fix only them.

## 4. Check the result

When the Builder returns, run `git status --porcelain --untracked-files=no` and
`git rev-parse HEAD`. It succeeded only if HEAD moved from the starting commit and the
tree is clean. If it did not commit, or left changes behind, do not commit for it: the
outcome is `error`.

## 5. Record the attempt

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" attempt --task <task> --spec-revision <spec_revision> --builder <builder> --kind <kind> [--fixes <fixes>] --diagnosis none --outcome <running|error> --started-at <start> --ended-at <now>
```

Use `--outcome running` when the Builder committed (the attempt is built and waiting
for review; `/sereno:ship` records its final outcome) and `--outcome error` when it did
not. Add `--fixes` only when the spec has one. The result is `{ ok, path, attempt }`;
if `ok` is false, show the error.

## 6. Stop

Reply in a few lines: the Builder used, the commit, and the Builder's own report in
one line. Tell the user to run `/sereno:ship <task>` when it exists, or review the
branch. Do not run tests, review the diff, merge or switch branches again.
