# Phase 4a follow-up: cheaper orchestration

Branch `feat/cheaper-orchestration`. Ships with the next release (plugin `0.2.0`).

## Why

The 2026-10-14 benchmark measured 5 small tasks, run once each. All dollar figures are estimates.

| Configuration | Cost per task |
|---|---|
| Opus alone | about $0.40 |
| Pipeline | $2.1–3.4 |

There was no quality gain, so the pipeline cost about five times as much. The Builders are cheap. The cost is the main session (Opus) running the orchestration skills. Each of task, build and ship costs $0.30–0.85. The "yes" turn that merges re-reads the whole conversation on Opus for a few git commands.

## What

1. **Orchestration on Sonnet.** Add `model: claude-sonnet-5-5` to the frontmatter of `task`, `build`, `ship` and `brief`. The docs say the override is turn-scoped: the session model resumes on the next prompt. The Builders, red team and scribe keep their own models.
2. **Merge is its own command.** Add `/sereno:merge <task>` with `model: claude-sonnet-5-5` and `disable-model-invocation: true`, so only the user can start it. Typing it is the explicit yes.
   - It runs `sereno.js recovery --task <task>`. It merges only when the action is `merge`; otherwise it says why and stops.
   - `recovery` today only checks that the latest attempt passed (gate `pass` with tests passed, or `skipped` with the red team off). Add the two missing checks in `recovery.js`/the subcommand, so they hold for ship too:
     - The gate's `head_commit` must equal the current tip of `refs/heads/task/<task>`. If it doesn't, the action is `review` with reason `head_moved`.
     - The gate's `spec_hash` must equal the current spec's hash. If it doesn't, the action is `decide` with reason `spec_changed`.
   - It runs the same clean-tree check as ship, then `git switch <base_branch>`, then `git merge --no-ff -m "Merge branch 'task/<task>'" <head_commit>` (the reviewed sha from `recovery`, re-checked against the branch tip first). On conflicts it runs `git merge --abort` and stops. It never runs a remote step.
   - Then the scribe refreshes the base branch's brief. Ship step 6 moves here unchanged.
   - Ship's step 6 now shows the same summary, then says: "Ready. Run `/sereno:merge <task>` to merge `task/<task>` into `<base_branch>`." Ship never merges.
3. **Docs.**
   - The README covers the flow, the roles table (orchestration: Sonnet), and the fact that skill models are fixed in frontmatter, like agents.
   - Update the recovery wording: "merge only after the user runs /sereno:merge".
4. **Tests.**
   - A lint test that every orchestration skill has `model: claude-sonnet-5-5`.
   - A lint test that `merge` has `disable-model-invocation: true` and no `Agent` in `allowed-tools` beyond the scribe.
   - Ship's text no longer contains `git merge`.
   - Merge's text runs `recovery` before `git merge`.
   - `claude plugin validate` passes.

## Verify

Rerun the benchmark with merge as `/sereno:merge tN` (no `--continue`). Record each call's `modelUsage` to confirm the skills ran on Sonnet under `-p`. If they didn't, note it and decide before release.

## Known limit

With the red team switched off (`skipped`), `/sereno:ship` stamps the tested head on the attempt (`attempt --update --outcome skipped --head`); a skipped attempt without it returns `decide` with `head_unknown`.
