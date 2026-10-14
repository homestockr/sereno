---
name: build
description: Run the spec's Builder on the task branch and record the attempt. Use after /sereno:task.
argument-hint: <task>
disable-model-invocation: true
model: sonnet
allowed-tools: Bash, Read, Agent
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written.

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
`node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" clean` (it runs at the repo root, whatever your directory, and ignores only the generated dirs `.sereno/attempts`, `gates`, `briefs` and `cache`); if `clean` is false, stop and list `files`.
Then run `git switch task/<task>`. If the branch does not exist, stop and point to
`/sereno:task`. Note the starting commit: `git rev-parse HEAD`, and the time (UTC,
ISO 8601).

## 3. Record the attempt before the Builder starts

One Builder run is one attempt record. Write it now, as `running`, so an interrupted run
still leaves a trace:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" attempt --task <task> --spec-revision <spec_revision> --builder <builder> --kind <kind> [--fixes <fixes>] --diagnosis none --outcome running --started-at <start> --spec .sereno/specs/<task>.md
```

`--spec` pins the spec: it records the sha256 of the spec file as `spec_hash`, and the later test and gate steps refuse with `spec_changed` if the spec is edited afterwards. Add `--fixes` only when the spec has one. The result is `{ ok, path, attempt }`; keep the
`attempt` number. If `ok` is false, show the error and stop.

## 4. Spawn the Builder

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
otherwise, including a turn or budget stop. The result is `{ ok, path, attempt }`; if
`ok` is false, show the error.

## 7. Stop

Reply in a few lines: the Builder used, the commit, and the Builder's own report in
one line. Tell the user to run `/sereno:ship <task>` next. Do not run tests, review the
diff, merge or switch branches again.
