---
description: Write or refresh this branch's Sereno brief
argument-hint: [task]
---

Write or refresh the Sereno brief for the branch I am on. Sereno reads this file to show
where the project stands. Follow these steps in order.

## 1. Find the branch

Run these three commands:

- `git branch --show-current` for the branch name.
- `git rev-parse --show-toplevel` for the worktree root.
- `git rev-parse HEAD` for the full 40-character head hash.

If the branch name is empty (detached HEAD), stop. Say "Detached HEAD: check out a branch, then run /brief again." Write nothing.

## 2. Choose the path

The file is `.sereno/briefs/<branch>.md` under the worktree root. Percent-encode the branch
name with `encodeURIComponent` semantics, so every `/` becomes `%2F`. Example: the branch
`feat/x` is written to `.sereno/briefs/feat%2Fx.md`. A branch with no special characters,
such as `main`, is `.sereno/briefs/main.md`. Create `.sereno/briefs/` if it does not exist.

## 3. Read the existing brief

If the file exists, read it and take its `version`. The new version is that number plus 1.
If the file does not exist, or has no readable `version`, the new version is 1. Remember the
version you saw.

## 4. Write the brief

The file has this exact shape: a front matter block, then three lines.

```
---
branch: feat/x
worktree: C:/Users/me/code/app
version: 3
source_commit: 0123456789abcdef0123456789abcdef01234567
task: add-export-button
generated_at: 2026-10-11T14:05:00Z
---
Now: Wiring the export button to the CSV writer; tests for empty input pass.
Next: Handle very large exports, then update the README section.
Blocked: None
```

Rules for each field:

- `branch`: the branch name exactly as git reports it, not encoded.
- `worktree`: the worktree root from step 1, with forward slashes only.
- `version`: the number from step 3.
- `source_commit`: the full head hash from step 1.
- `task`: `$ARGUMENTS` if I gave any. Otherwise a short kebab-case slug of the current work.
- `generated_at`: the current time in UTC, ISO 8601, like `2026-10-11T14:05:00Z`.

Then exactly three lines, each starting with its key and under 120 characters, plain text:

- `Now:` what is being worked on right now.
- `Next:` what happens next.
- `Blocked:` what is blocking progress, or `Blocked: None`.

Describe the work state from this conversation and from `git log`. Keep it factual. Use no
markdown, no bullets, no code, and no line breaks inside a line.

Never include secrets, keys, tokens, prompts, personal data or code in the brief. If you
are unsure whether something is sensitive, leave it out.

## 5. Check before writing

Just before you write, read the file again. If its `version` is not the one you saw in
step 3, someone else wrote it in the meantime. Go back to step 3 and regenerate from the new
version instead of overwriting.

## 6. Finish

Write only this one file. Do not commit, do not stage, and do not touch any other file.
Finish with one line saying where you wrote, for example: `Wrote .sereno/briefs/feat%2Fx.md (version 3).`
