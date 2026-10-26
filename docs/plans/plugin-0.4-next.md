# Plugin 0.4.0: `/sereno:next`

Status: A0-A3 and A5 done on `feat/plugin-0.4` (2026-10-25). The red team passed it on the
fifth pass, and the field fixes were reviewed and passed too. A4 (the app side) is deferred.
It ships on its own: merging to main is the release.

**A5 result (the field test in homestockr, 2026-10-25, ledger figures, est.):**
- **Run 1, default background subagents: $5.45.**
  - $1.89 was Opus session-model turns picking up agent results.
  - $0.43 was Fable agent summaries, which happen only for background agents.
- **Run 2, with `CLAUDE_CODE_FORK_SUBAGENT=0`: $2.92.** It ran in one turn from build to the
  merge line.
- **The leak was proven and found.** E3's "$0.44 leak" was background subagents, which are
  on by default in interactive Claude Code, plus plain replies starting turns on the session
  model.
- **The fixes:**
  - doctor and README advice to set `CLAUDE_CODE_FORK_SUBAGENT=0`;
  - decisions are taken by re-running a command, never by a plain reply;
  - preflight runs inside build on the task branch.
- **Other field findings:** a preflight false alarm on `dev`, and "Goal" as the merge title.
  Both are fixed.

## Why

Robe, 2026-10-18: a two-task job in homestockr took eight commands across hours. Each
hand-off said "then run X, then Y, then Z, once the gate passes I do W, then you run V". There
is too much to remember between tasks.

The plugin already knows the next step: `sereno.js recovery --task <x>` returns
`review | repair | retry | merge | decide | done`. Nothing acts on that answer, so the person
carries it in their head.

Skills cannot chain themselves. Every skill has `disable-model-invocation: true`, so only the
user can start one. That stays as it is: merge must keep needing an explicit yes.

## Decision

One new skill, `/sereno:next [task]`. It runs every step that needs no human, in one turn, and
stops at the first step that does. It ends with exactly one line naming what the user does next.

| State (from records + git) | `/sereno:next` does |
|---|---|
| spec exists, no attempts | the build step, then continues |
| `review` (built, not shipped) | the ship step, including its one repair, then continues |
| `retry` (environment failure, retries left) | the ship step again, then continues |
| `merge` | stops: "Gate passed. [hold text, if any.] Run `/sereno:merge <task>`." |
| `decide` | stops: the `reason` in one line, plus the command `merge` already suggests for it |
| `done` or merged into base | moves to the next queued task (below), or "Nothing queued." |

**Steps run in place, not as copies.** `next` reads `${CLAUDE_PLUGIN_ROOT}/skills/build/SKILL.md`
or `ship/SKILL.md` and follows it for the task. One source of truth per step. Its
`allowed-tools` is the union of build's and ship's.

**Merge stays manual.** `next` never merges and never runs anything against a remote. Typing
`/sereno:merge` is still the yes.

**Holds: human steps outside the pipeline.** A spec may carry `hold_before_merge: "<one line>"`
in its front matter, for example "Apply the migration to staging and run the rollback checks".
`/sereno:task --hold "<text>"` writes it. `next` prints it in the merge stop line, and `merge`
prints it again before merging. No new record type and no "hold done" flag: the user typing
`/sereno:merge` confirms it.

**Queued tasks.** A spec may carry `after: "<task>"`. `/sereno:task <name> --after <task>`
writes it and still creates the branch. When it starts, the branch is cut from the base as
usual. `/sereno:build` refuses a task whose `after` task is not merged into the base yet
(`git merge-base --is-ancestor task/<after> <base>`), with exit code and message
`after_not_merged`. With no argument, `next` picks a task as follows:
1. the one task in progress (has attempts, not `done`, not merged);
2. otherwise the oldest spec with no attempts whose `after` is merged or absent.

Two tasks in progress at once means `next` asks which one to run. It never guesses.

**`sereno.js next`.** A new read-only subcommand returns
`{ task, step, reason, hold, command }`, so the skill, the app and tests share one decision.
It wraps `recovery.decide`, adds the "no attempts" and "merged" states, and does the queue
pick. `recovery` itself is unchanged.

## Token efficiency (Robe, 2026-10-18)

Goal: cut cost per task without making the loop slower or weaker. Baseline from the 2026-10-14
bench (estimates): Opus alone about $0.40 per small task; pipeline `lean` $1.00-1.38, `default`
$1.61-1.69. The Builders are cheap. The cost sits in orchestration turns, the Fable red team,
and a cold-cache resume on the session model after the red team returns (about $0.44 per ship,
cause unconfirmed).

**E1. Size the review to the task. The gate never switches off; only the reviewer changes.**
- New config `roles.redTeam.light`:
  `{ "kinds": ["mechanical"], "maxDiffLines": 80, "agent": "sereno:red-team-lean", "never": [globs] }`.
- `never` holds default globs that always get the full red team: migrations, `supabase/**`,
  and paths matching auth, permission, payment, delete or secret. A repo may add globs but
  cannot remove the defaults.
- A new read-only `sereno.js reviewer --task --base --head` picks the agent. It uses the
  spec's `kind`, the diff line count and the touched paths, so no model makes the call. Ship
  uses its answer, and the gate record stores `reviewer_reason`.
- "Merge requires a gate pass" is unchanged.
- `light` is off by default in `default` and on in `lean`.

**E2. Bookkeeping is code, not model work.**
- `merge` stops spawning `sereno:scribe`. `sereno.js brief --auto --branch <base>` builds the
  brief from the records:
  - Now: the last merged task;
  - Next: the result of `sereno.js next`;
  - Blocked: open decisions.
- The merge commit message is built from the spec title: `Merge task/<x>: <title>`.
- `/sereno:brief` stays for a person who wants a written brief.

**E3. Prove the leak gone.**
- `/sereno:next` keeps build and ship in one foreground turn, which should end the Opus resume.
- Before release: one task with a before/after from Sereno's own ledger, recording each
  request's model.
- If any request after the red team still runs on the session model, find the cause and fix it
  before release. The README tip ("start on Sonnet") is not the fix.

**E4. A review pack, so the red team rediscovers less.**
- `sereno.js review-pack --task --base --head` writes `.sereno/cache/review-<task>.md`:
  - the spec's acceptance criteria;
  - diffstat and touched files;
  - the test summary from the test record;
  - touched files that have no test changes.
- The red team gets the pack path first and still reads any code it wants.
- The pack holds no file contents: paths, counts and spec text only.

**E5. Show the cost.** This is app-side, in A3, because the plugin cannot read the ledger.
- Next to each task's next command, show "about $X so far (estimate)".
- Spend is attributed to the task through its attempt time windows and the agents join, the same
  way `redTeamPerMerge` works.
- When attribution is not explicit, it says so.

**Process changes in this repo** (applied to CLAUDE.md the same day):
- one Builder run per fix, with every known point bundled in;
- the architect writes one-line commits; the Scribe is for release notes, PR text and changelogs;
- one red-team pass per branch, not per fix.

## App side (optional, step A4)

The app already bundles `recovery.js`. The Pipeline tab and the Projects brief card show each
task's next command (`/sereno:next` or `/sereno:merge <task>`) with a copy button, plus the
hold text and E5's cost estimate. It is read-only, so it fits "observes, never acts". A new
`next.js` lib module joins the bundled list, and the test that checks that list is updated.

## Not doing

- Auto-merge, or merge when the gate passes. That would break the decided "merge needs a yes".
- Running steps in the background, or in a loop across turns. Each `/sereno:next` is one
  foreground turn, the same rule the other skills follow.
- Applying migrations or any external step. Those are holds: printed, never run.

## Cost

Build and ship run in one Sonnet turn instead of two. The cache stays warm between them, so
the cost should be equal or a little lower. Check it with the existing bench on one task before
release.

## Living with Superpowers (A0)

The two plugins share no hooks, commands or paths. Two risks were found by reading the code on
2026-10-18; neither has been seen happen.
- **Builders have every tool, including Skill.** A Builder could run Superpowers'
  `using-git-worktrees` (the commit lands off `task/<x>`), `finishing-a-development-branch`
  (it offers a merge or push) or `requesting-code-review` (a second, paid reviewer). The red
  team and Scribe are already read-only.
- **The main session** gets Superpowers' "MUST invoke a skill" rule at session start. It could
  run brainstorming inside `/sereno:task`, adding question turns and a second design doc.

Fix:
- Builder agents get explicit `tools: Read, Edit, Write, Bash, Grep, Glob`. That is a hard
  block.
- Every Sereno skill gets one line: "This skill is the process for this run. Don't invoke other
  plugins' skills (planning, worktrees, review, branch finishing) while it runs."
- A README note.
- Before release, one end-to-end `/sereno:next` run with Superpowers on, confirming that no
  foreign skill ran.

A0 is small enough to ship first as plugin 0.3.1.

## Steps

- **A0, coexistence:** the above. It can ship alone as 0.3.1.
- **A1, plugin core:**
  - `lib/next.js`: the state table, queue pick, `after` check;
  - `sereno.js next`;
  - `after` and `hold_before_merge` in spec read/write;
  - `/sereno:task --after/--hold`;
  - `build` refuses `after_not_merged`;
  - tests in `tools/test.js`.
- **A2, plugin skill:**
  - `skills/next/SKILL.md`;
  - `merge` prints the hold;
  - README "Typical flow" rewritten around `next`;
  - plugin version 0.4.0.
- **A3, efficiency in the plugin:**
  - E1 `roles.redTeam.light` and `sereno.js reviewer`, plus ship using it;
  - E2 `brief --auto`, merge without the Scribe, and the merge message from the spec;
  - E4 `sereno.js review-pack`, plus the red team agents reading it first;
  - tests.
- **A4, app (optional):** next command, hold and E5 cost estimate in the Pipeline tab and
  brief card; bundle `next.js`; tests. Look at it in a browser before committing.
- **A5, measure (E3):** one bench task before and after, by model, from the ledger. Record the
  result in this plan. The release waits on it.
- Then the red team on the whole branch, then merge.

## Found in use: a failing repo hook stalls the Builder (homestockr, 2026-10-18)

What happened:
- The pre-commit hook failed on Expo patch drift, which has nothing to do with the task.
- The Builder stopped with its files staged and no commit, and the attempt was recorded as a
  plain `error`.
- `recovery` could only say `decide`, with no hint of the cause or the options.
- The architect then had to commit by hand (with `--no-verify`, which the user approved) and
  record it as a new attempt, a path the plugin doesn't support.

To handle, in A1/A3:
- **Preflight.** `/sereno:task`, or `next` before the build, runs the repo's commit hooks against
  the base, for example `git hook run pre-commit` or the husky equivalent. It reports a failure
  before any Builder tokens are spent. It is a read-only check, and nothing gets fixed.
- **A distinct diagnosis.** A Builder whose commit is refused by a hook records
  `diagnosis: hook_failed` with the first lines of the hook output, and leaves the tree as it is.
  `recovery` returns `decide` with the reason "repo hook failed: <line>", and the options are
  "fix it on its own branch" or "approve `--no-verify` for this commit". Nothing ever skips a
  hook without the user's explicit yes.
- **Adopting a commit.** `sereno.js attempt --adopt` records a user-approved commit of the
  Builder's staged work as a new `built` attempt, so ship can continue from it.

Also seen: the task's migration was 508 lines in one task. `/sereno:task` could warn when a
spec's scope looks too big for one review, and suggest splitting it. That is a heuristic only,
never a block.

## Open

- Should `next` also offer to write the next queued spec's branch when the previous merge lands?
  Default: no. `/sereno:task` already created it.
