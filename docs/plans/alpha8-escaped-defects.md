# alpha.8: escaped defects per reviewer

Status: plan written 2026-11-12 by the architect (Robe skipped the brainstorm questions). Ships
as `2.0.0-alpha.8`, with plugin `0.6.3`. Robe can overrule any decision below.

## The question it answers

"Is each reviewer worth what it costs?" A task created with `/sereno:task <name> --fixes
<merged task>` means the review passed something it shouldn't have. This was planned as H4 in
`docs/plans/plugin-0.5-harness.md`, and the plugin README already promises it: compare follow-up
fixes and cost per merge before and after trying a lighter setup.

It is read-only. It observes the records only. Nothing switches automatically.

## Findings (code read 2026-11-12)

- `fixes` is already recorded twice: in the spec front matter (`SPEC_FIELDS` in
  `src/pipeline.js`) and on every attempt record (`cleanAttempt`). Both are cleaned with
  `rec.checkTask`.
- **"Merged"** is decided in `taskView`: the latest gate's `head_commit` is an ancestor of the
  spec's base branch. The time of the merge is not recorded. The closest stand-in is that gate's
  `reviewed_at`.
- **Gap:** a task whose latest attempt is `skipped` (review off, or `review: none`) has no gate.
  So it never shows as merged, even though the attempt carries `head_commit`.
- **The gate does not say which reviewer ran or how big the review was.**
  - `sereno.js gate` receives `--agent-name` but uses it only to look up `model`.
  - `--reviewer-reason` is stored as free text.
  - The `light` flag from `reviewer` is not stored at all.
  - The app's `cleanGate` drops `reviewer_reason`.
- `redTeamPerMerge` already computes red-team spend per merged pass gate from the ledger
  (`spendForAgent`). It is global, not per reviewer.
- `buildPipeline` (`src/collector.js`) passes `signals()` only `{ task, stage, gates }`
  per task. Check whether `pv.tasks` from the repo snapshot carries the spec's and attempts'
  `fixes`; if it doesn't, carry it through `src/repos.js`.

## Definitions

- **Merge:** a task whose stage is `merged`, so the work has landed on its base branch.
- **Final review:** the gate that `taskView` used to decide "merged". For a skipped task, the
  skipped attempt stands in for it.
- **Merged at:** the final review's `reviewed_at`, or for a skipped task the attempt's
  `ended_at`.
- **Follow-up fix:** any other task in the same repo whose `fixes` names the merge. The spec's
  value wins; otherwise use the newest attempt's value. The fix counts as soon as its spec
  exists, whether or not the fix is merged. A task that names itself is ignored.
- **Escaped merge:** a merge with at least one follow-up fix. The rate is escaped merges over
  merges. The card also shows the total number of fixes.
- **Unmatched fix:** a `fixes` value that names no merged task in that repo. It is counted and
  shown as a number, never guessed at.

## Decisions (architect, 2026-11-12)

1. **Group by reviewer and size.** The groups are:
   - each reviewer agent (`red-team`, `red-team-lean`, `red-team-browse`, and any configured
     fallback) × size (`full` or `light`);
   - `No review (spec)`, for `skip: spec`;
   - `Gate off`, for `skip: off`;
   - `Unknown`, when the reviewer can't be told.
2. **Plugin 0.6.3 records the reviewer.** The gate gets `reviewer: { agent, light }`.
   - `agent` is the cleaned `--agent-name`.
   - `light` comes from a new `--light true|false`, which the ship skill passes from the
     `reviewer` result.
   - Old gates have no `reviewer`. The app uses the gate's `model` instead, but only when
     exactly one reviewer agent in `agentModels()` has that model family. Their size is
     `Unknown`; the app never parses `reviewer_reason` text.
3. **A 90-day window, by merge date.** 30 days leaves too few merges at Robe's volume. Fixes
   that come later still count against the merge's window. The card shows the window.
4. **Cost next to rate:** red-team spend per merge (est.) for each group, computed the way
   `redTeamPerMerge` already does it. Builder spend is not included in this release.
5. **Small numbers stay honest.**
   - Every rate shows its n, as "2 of 9".
   - A percentage appears only when n ≥ 5, rounded at the source.
   - The amber colour is not used here, because none of this needs Robe to act.
6. **Merged for skipped tasks.** `taskView` also says `merged` when the latest attempt is
   `skipped` and that attempt's `head_commit` is an ancestor of the base branch. This also fixes
   the Work view, which never shows those tasks as merged today.
7. **Privacy:** task names, counts and reviewer names only. No findings text, no spec body.

## Not doing

- Builder cost per merge, and escapes per Builder model. These could come later from the same
  data.
- Any automatic change to presets or config.
- Fixes recorded across repos (`fixes` is a task name within one repo).
- Showing the plugin version per project. It stays open.

## Steps

- **A1, plugin 0.6.3: record the reviewer.**
  - `sereno.js gate` takes `--light true|false` and writes `reviewer: { agent, light }`.
    - `agent` is `--agent-name` after `matchId` cleaning, or null.
    - `light` is a boolean, or null when the flag is missing or invalid.
    - Leave the field out entirely when both are null, so old consumers see the old shape.
  - The ship skill's gate command passes `--light <light from reviewer>`, and leaves it out
    when `reviewer` failed.
  - Bump `plugin.json` to 0.6.3. Add a README changelog line. Check the bundled-modules list
    test still passes; `sereno.js` is not bundled.
  - Tests: the field is written, missing or invalid values give null or no field, and a skill
    text test covers the new flag.
- **A2, `src/pipeline.js`.**
  - `cleanGate` keeps `reviewer`. `agent` must match `/^[a-z0-9-]{1,64}$/`, otherwise it is
    null. `light` must be a boolean, otherwise null.
  - `taskView` adds the skipped-task merge from decision 6.
  - The view exposes `finalReview: { kind: 'gate' | 'skip', agent, light, skip, at, sessionId,
    agentId }` for a merged task, and `fixes` for every task.
  - New pure function `escapes(projects, now, models, spendForAgent)` returns:
    `{ days: 90, groups: [{ key, label, merges, escaped, fixes, ratePct | null,
    redTeamPerMerge: { mean, n, excluded } }], unmatched, merges }`.
    - Groups are sorted by merges, highest first.
    - The fallback from `model` to agent follows decision 2.
  - Tests:
    - each definition above, including a self-reference, unmatched fixes, a fix to a task
      outside the window, two fixes for one merge, and a skipped merge;
    - an old gate with a unique model and an old gate with a shared model;
    - `ratePct` is null below 5;
    - rounding.
- **A3, collector.** `buildPipeline` feeds `escapes()` the per-task `fixes` and `finalReview`
  (carried through `repos.js` if A2's finding says so) and returns `escapes` in
  `/api/pipeline`, through the same `pStr`/`pNum` cleaning. Tests:
  - the shape;
  - hidden projects are excluded;
  - with no ledger, every `redTeamPerMerge.mean` is null.
- **A4, Signals card "Escaped defects (90 days)".** It goes in the Signals sub-tab after
  "Rework and cost".
  - One row per group, with the columns: Reviewer, Size, Merges, Fixed later ("2 of 9", plus a
    percentage when n ≥ 5), Fixes, Red team per merge (est., with n).
  - A footnote with the unmatched count when it isn't zero.
  - Empty state: "No follow-up fixes recorded yet. Mark one with `/sereno:task <name> --fixes
    <merged task>`."
  - Theme tokens only.
  - Tests: markup, escaping, `est.` on every $, n on every rate, no stray hex.
  - Look at it in a browser at 1360px and 1920px with seeded records before committing.
- **A5, docs.**
  - The plugin README's "Trying a lighter setup" points to the card.
  - CLAUDE.md roadmap: alpha.8 as built, plus plugin 0.6.1/0.6.2/0.6.3.
- **Then:** the red team on the branch, a version bump to `2.0.0-alpha.8`, the installer,
  release notes from the Scribe, and publish. Ask Robe before the push, the merge and the
  release, and before the plugin marketplace update.
