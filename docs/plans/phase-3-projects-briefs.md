# Phase 3 — Projects and briefs

Status: ready to build · Branch: `feat/projects-briefs` off `main` · Ships as `2.0.0-alpha.3`

Goal: the console opens on a Projects tab that answers "where is each project?" Each
repo you work in shows a headline brief (Now / Next / Blocked) with its freshness, its
branches, git state, open PRs and 14-day spend. Briefs are written by a `/brief`
command in Claude Code; Sereno only reads them. "Review in terminal" comes to the
console.

Spec exit: "every registered repo shows a fresh, behind or stale brief, and saving a
brief never marks it behind." Design baseline: `docs/design/console/projects-dark.png`,
`projects-calm.png`, and the README's rules.

## Decisions (Robe, 2026-10-11)

- **Briefs come from a `/brief` command** plus a scribe agent template shipped in
  `templates/`. You run `/brief` in a session. Sereno never writes to a repo.
- **Repos register themselves.** Any git repo a Claude Code session runs in becomes a
  project. You can hide one.
- **"Review in terminal" is in the console,** behind Origin checks and a per-launch token.
  It does exactly what the widget's button does: raise the session's terminal.
- **Open PRs via `gh`,** when it is installed and signed in. Hidden otherwise.

## Architect decisions

- **Registry is `~/.sereno/projects.json`,** not the ledger. Projects must work with spend
  history off. Each entry: `{ id, name, repoPath, hidden, firstSeen }`. `id` is a hash of
  the normalised repo path. Written atomically like `config.json`.
- **Worktrees map to one project.** The git root comes from
  `git rev-parse --path-format=absolute --git-common-dir`, then its parent. So
  `C:/x/sereno` and a worktree `C:/x/sereno-wt` are one project with two worktrees.
- **Git runs off the hot path.** Every git call is async `execFile('git', …)` with
  `windowsHide`, a timeout of 5 s, and at most 2 repos polled at a time. A hook never
  waits for git. Registration is queued after the hook response.
- **Read only what's needed.** Branch names, commit hashes and times, ahead/behind,
  dirty flag, worktree paths, and brief files. No commit messages, no diffs, and no file
  contents other than `.sereno/briefs/*.md`.
- **Briefs are read from the filesystem of every worktree,** not through `git show`. They
  may be uncommitted or gitignored. If two worktrees hold the same branch's brief, the
  higher `version` wins.
- **Briefs live in memory.** No brief history in SQLite this phase. Each `Now` / `Next` /
  `Blocked` line is capped at 200 characters, with control characters stripped. They are
  escaped at render like every other string.
- **Freshness, per the spec:**
  - `behind` when the branch has commits after `source_commit` that touch anything outside
    `.sereno/` and `STATUS.md`. Check it with
    `git log --format=%H%x09%ct <source_commit>..<branch> -- . ':(exclude).sereno' ':(exclude)STATUS.md'`.
  - `stale` when the oldest such commit is over 24 h old.
  - `none` when there is no brief.
  - `unknown` when `source_commit` is not in the repo, shown as "brief source not found".
- **Spend per project** joins ledger sessions to projects when the session's `cwd` lies
  under one of the project's worktrees. That is case-insensitive on Windows, with
  separators normalised. With the ledger off, the spend column is absent rather than zero.
- **The POST guard for console actions** (review, hide) has four parts:
  1. The existing Host check.
  2. `Origin` must equal `http://127.0.0.1:<PORT>`. Browsers always send it on POST.
  3. `content-type: application/json`, so any cross-site request needs a preflight that
     never passes.
  4. `X-Sereno-Token` must equal a random token made at collector start. The console gets
     it from `GET /api/token`, which the same Host/Origin rules protect.
  The client never supplies a pid or a path. The server maps a `sessionId` to its own
  record. Under `npm run serve` there is no terminal to raise, so review answers 501.
- **`gh` is polled every 5 minutes per project,** with a 10 s timeout. `ENOENT` turns it
  off for the run. An auth error hides the PR count for that project.

## Exit criteria (each is a test in `tools/test.js` under `[projects exit]`)

1. Every registered, unhidden repo shows exactly one of `fresh`, `behind`, `stale`, `none`
   or `unknown` for its headline brief. Test this with temp git repos.
2. A commit that touches only `.sereno/briefs/` or `STATUS.md` never makes a brief
   `behind`. A commit to any other file does. After that commit's time plus 24 h, the
   brief is `stale`.
3. A session in a worktree registers the main repo once, not twice.
4. Polling never runs git on the hook path. A `/hook` POST answers while a slow git
   (stubbed at 3 s) is in flight.
5. `POST /api/review` and `/api/projects/:id/hide` reject:
   - a foreign Origin
   - a missing or wrong token
   - a non-JSON content type
   - an unknown session or project
   Review never accepts a pid from the client.
6. No commit message or file content other than brief lines appears in any `/api/*`
   response. Brief lines are capped and have their control characters stripped.
7. The `/brief` install never overwrites a different existing file with the same name.

## Steps

Each step is one Builder task. It ends with `npm test` green and adds its own tests,
using temp git repos made with `git init` in the OS temp dir. The architect reviews and
commits. The red team reviews the whole branch before merge.

### Step 0 — Project registry

`src/projects.js` (`// @ts-check`):
- `resolveRepo(cwd)` → `{ root, worktree }` via git (async). Not a repo → null. Cache by
  cwd for 10 minutes.
- `registry` read/write of `projects.json` (atomic, tolerant of corrupt files), plus
  `register(root)`, `hide(id)`, `unhide(id)` and `list()`.
- The collector, after answering `/hook`, queues `cwd` for registration. One in-flight
  resolve per cwd, and a missing `cwd` is ignored.
- Tests: plain repo, a nested folder inside a repo, a worktree (same project), not a repo,
  a corrupt `projects.json`, hide/unhide, an unchanged `/hook` response time.

### Step 1 — Repo poller: git state

`src/repos.js` (`// @ts-check`):
- Every 30 s, poll each unhidden project with a concurrency of 2:
  - current branch per worktree
  - default branch (`origin/HEAD`, else `main`, else `master`, else the current branch)
  - local branches with their last commit time
  - ahead/behind of the default branch against its upstream
  - a dirty flag (`git status --porcelain --untracked-files=no`, true if any line)
  - the worktree list
- State is held in memory: `snapshot()` → per project. Any git failure keeps the last
  good state and records `error: true`.
- Branches shown: the default branch plus branches with a commit in the last 14 days or
  with a brief, at most 8 per project.
- Tests against temp repos: an ahead/behind count via a local bare "origin", the dirty
  flag, a worktree branch, a git error, and timeout handling via an injected exec.

### Step 2 — Briefs and freshness

In `src/repos.js` (or `src/briefs.js` if it grows):
- `parseBrief(text)` → `{ branch, worktree, version, sourceCommit, task, generatedAt, now,
  next, blocked }`. It uses a small `key: value` front-matter parser with no YAML
  dependency and three body lines. Anything malformed returns `null` and is counted.
- Read every `.sereno/briefs/*.md` from each worktree. The file name is the
  percent-encoded branch, and the front-matter `branch` wins.
- Freshness as decided above, with git calls under the same concurrency and timeouts.
  Recompute only when the branch head or the brief's `version` changes.
- Tests: parse round trip, a malformed brief, an over-long line, control characters; each
  freshness state from real commits; `.sereno`-only and `STATUS.md`-only commits stay
  fresh; the 24 h stale threshold via an injected clock.

### Step 3 — `/brief` command and scribe template

- `templates/commands/brief.md`: a Claude Code slash command. It tells Claude to write
  `.sereno/briefs/<percent-encoded branch>.md` in the spec's format: front matter (`branch`,
  `worktree`, `version` = previous + 1, `source_commit` = `HEAD`, `task`, `generated_at`)
  and three lines, `Now:` / `Next:` / `Blocked:`, under 120 characters each. It re-reads
  the file just before writing, and if `version` changed it regenerates. It never puts
  secrets, prompts or code in the brief.
- `templates/agents/scribe.md`: the spec's scribe role, so Phase 4 can reuse it.
- `wiring.installCommands()` / `uninstallCommands()` copy `brief.md` into
  `~/.claude/commands/`. A different existing file with that name is a conflict: nothing
  is written and the conflict is reported. Record what was installed in `wired.json`.
  Uninstall removes it only if it is unchanged.
- `npm run wire -- --commands` and a button in the widget's settings panel ("Install
  /brief command"), each behind a confirmation, because it writes into `~/.claude/`.
- Tests: install, idempotence, conflict, unwire only when unchanged, all under a temp
  `CLAUDE_CONFIG_DIR`.

### Step 4 — API and console actions

- `GET /api/projects` →
  `{ asOf, projects:[{ id, name, hidden, freshness, brief:{now,next,blocked,generatedAt}|null,
  git:{ defaultBranch, ahead, behind, dirty, lastCommitAt }, prs:n|null,
  branches:[{ name, freshness, now }], spend14:{ costMicros, trend:[14] }|null,
  lastActivity, error }] }`, built from explicit key lists.
- `gh` PR counts as decided.
- `GET /api/token`, `POST /api/review` `{ sessionId }` and `POST /api/projects/:id/hide`
  `{ hidden }`, behind the guard. Review calls an `onReview(session)` hook that main
  provides. Main raises the session's terminal with the same code as `sereno:focus`, with
  the pid taken from the store, never from the request. Under serve the hook is absent
  and the route returns 501.
- Tests: exit 5 in full, shapes and the key allowlist, the gh stub (missing, signed out,
  count), and review mapping to the store's pid.

### Step 5 — Console Projects tab

- Projects becomes the default tab, with nav **Projects · Spend**.
- Summary line, e.g. `N projects · N with blockers · N stale · nothing needs a decision`,
  and filters All / Active / Quiet. "Active" means a live session or a commit in the last
  24 h. Sort by last activity.
- A card per project as in `projects-dark.png`:
  - name with a freshness chip; behind and stale use the dashed rule
  - Now / Next / Blocked
  - git line: default branch, ↑↓, open PRs, "Last commit 8 min ago"
  - branch rows with freshness and their brief's `Now`
  - 14-day spend sparkline and total
  No gate line yet (Phase 4).
- Empty states:
  - no projects: "Projects appear when a Claude Code session runs in a git repo"
  - no brief: "No brief yet — run /brief in a session", with the install hint if it isn't
    installed
- A "Live sessions" strip from `/state`.
- The attention panel gains the **Review in terminal** button, which calls
  `POST /api/review` and is hidden under serve. A per-card menu has "Hide project".
- The strict CSP, `esc()` everywhere, and no inline styles all still apply. Pure render
  functions are tested from source.

### Step 6 — Exit tests, docs, release prep

- `[projects exit]` tests for criteria 1–7.
- README gets a "Projects and briefs" section covering `/brief`, freshness and what is
  read from your repos.
- `package.json` → `2.0.0-alpha.3`.
- Render both console tabs in Chrome against seeded temp repos.
- Red team on `main...feat/projects-briefs`, then Robe's click-through of the packaged
  build, then ask before merge, push and release.

## Out of scope for Phase 3

Gates and gate files, the pipeline, roles, "Latest activity" (it needs gate and attempt
events), brief history in SQLite, Clear history, Sessions and Pipeline tabs, non-Windows
code.
