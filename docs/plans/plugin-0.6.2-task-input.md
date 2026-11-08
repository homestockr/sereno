# Plugin 0.6.2: task text without the long paste

Status: planned 2026-11-08, branch `feat/plugin-0.6.2`.

## Why

Robe, 2026-11-08: pasting a long `/sereno:task <name> <goal>` line loses text. The `paywall-prices` command in
homestockr lost chunks in at least six places (`MATCHEg.ts:148`, `planrs.ts`, `ONE_TIME_PRIavingPercent`, …).
The spec only came out right because the same text had been pasted cleanly as a message just before. The
skills are user-only (`disable-model-invocation: true`, on purpose), so the user always types the command.

## Decisions (Robe, 2026-11-08)

1. **The goal can come from the conversation.** `/sereno:task <name> [flags]` with no goal uses the task the
   user described in their latest message(s) before the command.
2. **Garble guard in code.** Before writing a spec, check the file paths and code names in the source
   text against the repo. Anything that doesn't resolve and isn't described as new stops the skill with a
   list.

## Steps (one Builder run)

**G1, `sereno.js refs`.**
- Usage: `refs --text-file <cacheDir>/spec-<name>.source.md`. It reads the file and then deletes it. The file
  must be under `cacheDir`, the same rule as `spec --body-file`.
- Output: `{ ok: true, checked, missing: [{ ref, kind, why }], new: [{ ref, kind }] }`. Each list is
  capped at 50.
- It extracts two kinds of token. Surrounding punctuation, quotes, backticks and parentheses are stripped.
  - **Paths:** a token containing `/`, or one ending in a code or doc extension (`ts tsx js jsx mjs cjs json
    md py go rs css html yml yaml sql sh`). It may carry `:<line>` or `:<a>-<b>`.
  - **Code names:** 4–80 characters. camelCase with an inner capital, PascalCase with at least two
    capitals, or UPPER_SNAKE with an underscore.
- How a token resolves:
  - **Paths:** an exact tracked path. A bare file name resolves only when exactly one tracked file has
    that name. A line reference must be within the file's line count.
  - **Code names:** a whole-word, fixed-string `git grep` over tracked files.
- How a token that doesn't resolve is classed:
  - `new` when one of `new`, `create`, `add`, `introduce` or `extract` is within 8 words of it on either
    side;
  - `missing` otherwise;
  - always `missing` when it has a line number, because a new file has no line 148.
- If git fails, it returns `{ ok: false, error }`. It uses the existing exit-code conventions.
- It lives in a new `plugin/bin/lib/refs.js`. The app's bundle of plugin modules doesn't change.

**G2, the `task` skill.**
- **Where the goal comes from:**
  - (a) the text after the name in `$ARGUMENTS`, flags excluded;
  - (b) otherwise, the task described in the user's latest message(s) before the command in this
    conversation;
  - (c) otherwise, end the turn with: "Describe the task in a message, then run `/sereno:task <name>`".
- **Revisions:** when the spec already exists and `$ARGUMENTS` holds only a name and flags, it stays a
  flags-only revision, as today. The conversation is not read as a new goal unless the user asked for a
  change.
- **The guard:**
  - Write the source text verbatim to `<cacheDir>/spec-<name>.source.md` and run `refs`.
  - When (a) and (b) both exist, check both. If (a) has missing items and (b) has none, use (b) and say
    so.
  - If the chosen source still has missing items, end the turn. List them, say the text may have been
    cut while pasting, and say to paste the task as a message and run `/sereno:task <name>` again.
  - `--refs-ok` in `$ARGUMENTS` skips the stop. Items marked `new` never stop the skill.
- **The report** names the source: "from your message above" or "from the command".
- `argument-hint` becomes `<name> [goal, or describe it in a message first]`.

**G3, docs and version.** Add a "New in 0.6.2" note to the README, plus `refs` in the command list. The
version becomes `0.6.2` in plugin.json and marketplace.json.

Each step adds its own tests in `tools/test.js`. Run `refs` against a temp repo containing the garbled
`paywall-prices` tokens. Test that a skill-text guard covers the source order and `--refs-ok`.

## Addendum: second red-team block (stop and warn)

- `refs` now returns `{ ok, checked, missing, warn, new }`. The `new` proximity rule applies first, as before.
  - `missing` (stops the skill; `--refs-ok` skips the stop): a path with a directory part that doesn't resolve,
    any path with `:line` (unresolved or out of range), a camelCase or UPPER_SNAKE name that isn't found.
  - `warn` (listed only, never stops): a bare file name with no directory that doesn't resolve
    (`planrs.ts`, `settings.json`, `Node.js`), a PascalCase name that isn't found (`TypeScript`, `GitHub`).
  - The step-5 report lists `warn` items on one line: "Check these names, which aren't in the repo: ...".
- `@` is no longer a path character, so `robe@x.md` is not a path.
- A bare dotted token (`.eslintrc.json`) is a path only when tracked (or its name matches a tracked bare
  name); otherwise it is ignored. Decided in `check`.
- `git grep` runs with `--no-line-number --no-column --no-color`, so the user's `grep.*` and `color.*` config
  can't change its output.
- The on-disk (untracked) resolve compares `realpath` of the target with `realpath` of the root; a junction
  or symlink out of the root doesn't resolve and is never read for a line count.
- Accepted limit: a path truncated at its tail with no extension (`lib/billin`) is prose and isn't caught.

## Addendum: prose that must not stop the skill

- Weak (warn, never stop): a one-letter-prefix brand (`iPhone`, `iPad`, `iCloud`, `jQuery`, `eBay`), a lowercase prefix
  plus `OS` (`macOS`, `tvOS`), and an all-caps UPPER_SNAKE name (`NODE_ENV`, `CI_COMMIT_SHA`, `$HOME_DIR` with the `$`
  stripped). A mixed-case snake name (`ONE_TIME_PRIavingPercent`) and other camelCase names
  (`whengetOfferings`, `resolvePackage`) stay strong.
- Skipped: markdown emphasis (a token that starts and ends with `_`), a word containing `://`, and a word starting with `@`.
- A bare dotted token with a `:line` (`.env.local:3`) is never ignored. It resolves if the file exists inside the root
  with the line in range; otherwise it is `missing`.
- Accepted limits, these garbles don't stop the skill: PascalCase garbles (`PaywallScren`) and all-caps env-style
  names only warn; lowercase-collapsed garbles (`resolvepackage`, `planrsts`) aren't caught.
- `git grep --no-column` needs git 2.19 or newer.
