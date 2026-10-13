---
name: task
description: Write a task spec and create its task branch. Use to start a piece of work for the Sereno pipeline.
argument-hint: <name> [one-line goal]
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit(.sereno/cache/spec-*.md)
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written.

You are the architect. You plan; you do not write the feature code. Turn the request
into a spec a Builder can follow with no other context, then create its branch.

Arguments: `$ARGUMENTS`. The first word is the task name (letters, digits, `.`, `_`,
`-`; up to 64 characters). The rest is the goal. If the name is missing, ask for it.

## 1. Understand the work

Read what you need in the repo (CLAUDE.md or README, the files involved). Decide the
acceptance criteria: observable outcomes a reviewer can check, the files or areas in
scope, what is out of scope, and the tests that must exist. Keep it short and concrete.

## 2. Choose the Builder and record why

| Builder  | Use for |
|----------|---------|
| `haiku`  | Mechanical work where you can name the files: renames, config edits, copy changes, a pattern applied in several places. |
| `sonnet` | Ordinary feature work, fixes and refactors. The default. |
| `opus`   | Substantial work that needs judgment: design across modules, tricky concurrency, migrations. Choose it explicitly, never by drift. |

Never use `haiku` for security-sensitive or judgment-heavy work, for example anything
like "fix authentication", permissions, data deletion, or payment handling.

Choose `--kind` as one of `mechanical`, `feature`, `fix`, `refactor`. If this task
repairs an earlier task, pass `--fixes <that-task-name>`.

`--reason` is one plain sentence on why this Builder fits (for example "five named
files, same edit in each"). It is recorded; the person reviewing it will read it.

## 3. Create the branch (new tasks only)

If branch `task/<name>` does not exist yet, create it first from the current HEAD:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" branch --task <name>
```

It prints one JSON object. If `ok` is false, show the `error` to the user and stop. It
refuses an existing branch, a dirty working tree and an invalid name. Do not work around
a refusal. Note `from_branch` in the result: it is the branch the task branch was created
from, and `/sereno:ship` merges back into it. If it is null (detached HEAD), ask the user
which branch the work should merge into. If the branch already exists, you are revising
the spec: skip this step.

## 4. Write the spec

First run `node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" paths` and take `cacheDir` (an absolute path at the repo root; your working directory may be a subdirectory).
Write the acceptance criteria (markdown, no front matter) with the Write tool to
`<cacheDir>/spec-<name>.md`. This is the only path you write to; never write the spec
file under `.sereno/specs/` by hand, and never pipe or heredoc the text into a command. The
command below reads that file, deletes it, and writes the real spec with its front matter
and a bumped `spec_revision`.

The file content is:

```
## Goal
...
## Acceptance criteria
- ...
## Out of scope
- ...
## Tests
- ...
```

Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" spec --task <name> --builder <haiku|sonnet|opus> --kind <mechanical|feature|fix|refactor> --reason "<why this Builder>" --body-file .sereno/cache/spec-<name>.md
```

Add `--base-branch <from_branch>` when you just created the branch (a spec revision keeps
the earlier value when you omit it). Add `--fixes "<task>"` when it applies. The result is `{ ok, path, spec_revision, spec_hash }`.

## 5. Report

Reply in a few lines: spec path and revision, the Builder you chose and why, and the
branch. Tell the user to run `/sereno:build <name>` next. Do not start the Builder
yourself, and do not switch branches.
