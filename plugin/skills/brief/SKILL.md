---
name: brief
description: Write or refresh this branch's Sereno brief. Use to record where the work stands.
argument-hint: [task]
disable-model-invocation: true
model: claude-sonnet-5-5
allowed-tools: Bash, Read, Grep, Glob
---

## How to run commands

Run every shell command in this skill with the Bash tool, never PowerShell or cmd. The commands here use bash syntax (quoting, heredocs), which PowerShell cannot run as written. Run every command and every agent in the foreground and wait for it in this turn: a background result arrives as a new turn on the session model with a cold cache. Never use `run_in_background`. For a long command such as the test run, pass a Bash `timeout` of 600000.

Write or refresh the Sereno brief for the branch I am on. Sereno reads this file to show
where the project stands. Arguments: `$ARGUMENTS` (an optional task name).

## 1. Find the branch

Run `git branch --show-current`. If it prints nothing (detached HEAD), stop and say
"Detached HEAD: check out a branch, then run /sereno:brief again." Write nothing.

## 2. Read the existing brief

The file is `.sereno/briefs/<branch>.md`, with the branch percent-encoded the way
`encodeURIComponent` does it (`feat/x` is `feat%2Fx.md`). If it exists, read it and note
its `version`. If it does not exist, or has no readable `version`, the version you saw is 0.

## 3. Compose three lines

Describe the work state from this conversation and from `git log`. Keep it factual.

- `Now`: what is being worked on right now.
- `Next`: what happens next.
- `Blocked`: what blocks progress, or `None`.

Each is one plain-text line under 120 characters. No markdown, bullets, code or line
breaks. Never include secrets, keys, tokens, prompts, personal data or code. If unsure
whether something is sensitive, leave it out. Do not use double quotes, backticks or `$`
in the text, so the shell passes it through unchanged.

## 4. Write it with the brief command

Never write the file by hand. The command writes the front matter, bumps the version and
writes atomically. Pass the version you saw in step 2 as `--expect-version`:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js" brief --branch <branch> --task <task> --now "<now>" --next "<next>" --blocked "<blocked>" --expect-version <version you saw>
```

Use `$ARGUMENTS` as `<task>` if given; otherwise a short kebab-case slug of the current
work. The result is `{ ok, path, version, source_commit }`.

- `code: "version_conflict"`: someone wrote the brief in the meantime. Nothing was
  written. Go back to step 2 and regenerate from the new version.
- `code: "detached_head"`: stop as in step 1.
- Any other `ok: false`: show the `error` and stop.

## 5. Finish

Write only this one file. Do not commit, stage or touch any other file. Finish with one
line, for example: `Wrote .sereno/briefs/feat%2Fx.md (version 3).`
