# Plugin 0.6.0: choose the review per task

Status: planned 2026-10-30, branch `feat/plugin-0.6`.

## Why

Robe, 2026-10-30: every change gets a full red-team review, however small. Adding an icon shouldn't
need one. The review should run only when it is really needed.

Data from homestockr, 10-18 to 10-30 (estimates):
- 31 reviews, every one a full Fable review, because light review was off. Reviews cost about $51
  and all Builders together about $21.
- 19 of 25 tasks passed their first review. All 6 blocks had a medium finding, and 2 of them were
  icon tasks (`spanish-item-icons`, `smoke-detector-icon`), with tests passing both times. Skipping
  the review is a real trade-off, and it is the user's to make.

## Decisions (Robe, 2026-10-30)

- **Per task, in the spec.** The front matter gains `review: full | light | none`. The spec hash
  covers the front matter, so the choice is pinned like everything else. Changing it after a build
  is a `spec_changed`.
- **Chosen at `/sereno:task`.** The skill proposes a level from rules (below) and the user can
  pass `--review`. There is no extra stop at ship time.
- **Safety floor.** When the spec says `none` or `light` but the diff touches a path that always
  gets the full red team (`ALWAYS_FULL` in `review.js`, plus `roles.redTeam.light.never`), the
  full red team reviews it. The reason says the floor overrode the spec.
- Kept as they are:
  - browse checks always get `red-team-browse`;
  - `roles.redTeam.enabled: false` still switches the review off for the whole repo;
  - a spec with no `review` field (every spec written before 0.6) behaves exactly as today.

## Steps

One Builder run for all of it. Every step adds its tests in `tools/test.js`.

**R1, the spec.**
- `sereno.js spec` takes `--review full|light|none`. Anything else is a `usage` error. It is
  written to the front matter after `kind`.
- With no `--review`, a new revision keeps the previous revision's value, the same way `--after`
  and `--check-hosts` are kept.
- `readSpecMeta` returns `review` (`null` when absent or not one of the three).

**R2, choosing the reviewer** (`review.js` `reviewer`, in code). It reads the spec's `review`.
The order:
1. Browse checks: `red-team-browse`, as today.
2. Spec `none` or `light` with a diff touching a floor path: the full red team. The reason is
   "the spec asks for <level> review, but <path> matches <rule>; full review".
3. Spec `none`: `{ agent: null, light: false, skip: true, reason: "no review: chosen in the spec" }`.
4. Spec `light`: `light.agent`, `light: true`. The user's choice overrides `light.kinds` and
   `maxDiffLines`; only the floor overrides it.
5. Spec `full`: `red.agent`.
6. No `review` field: the current logic, unchanged.

The diff is read for steps 2 to 4 too. If it cannot be read, `none` and `light` fall back to the
full red team with a reason saying so.

**R3, the records.**
- An attempt record gains `skip: "off" | "spec" | null`, written by
  `sereno.js attempt --update --outcome skipped --skip off|spec`. `--skip` is valid only with
  `--outcome skipped`, and `skipped` without `--skip` stays valid and means `off`, so older
  records are unchanged.
- In `recovery.js`, `skipped` is valid when the red team is off **or** the attempt's `skip` is
  `spec`. Every other `skipped` rule stays the same, including the need for a recorded head.
- `next.js` already accepts `skipped` for merges. Check that a spec skip merges and an `off` skip
  with the red team turned back on is still a `decide`.
- The app bundles `records.js` and `recovery.js`, so the bundling test must still pass.

**R4, the spec review.** `specreview.needed` takes the spec's `review`. `none` and `light` mean
no spec review ("the spec asks for <level> review, so no spec review"). `full` means the current
rule. No field also means the current rule.

**R5, the skills.**
- `task`: a new section, "Choose the review", after the Builder choice. It proposes:

  | Level | For |
  |---|---|
  | `none` | Assets, copy, config or generated files with no new logic, where the tests or checks cover the result. Example: add an icon and its mapping. |
  | `light` | Small, plain fixes and mechanical changes with logic in them. |
  | `full` | Features, new logic, data or schema, anything near the floor paths, any Opus task. |

  The user's `--review`, or plain words like "no review", always win. The summary states the level
  and how to change it before the build (run `/sereno:task <name> --review <level>` again).
- `ship`: when `reviewer` returns `skip: true`, take the existing skipped path with `--skip spec`.
  The final summary says "skipped: no review chosen in the spec". When the red team is off,
  `--skip off` and today's wording.
- `next`: same wording in its summary.

**R6, the app.** The Pipeline tab labels a `skipped` gate by its `skip` value: `spec` reads
"No review (chosen)" and `off` reads "Review off". Only the copy changes, in the existing tokens.

**R7, docs and version.**
- `plugin/README.md`: the spec field, `--review`, the floor, and a line in the config table under
  `roles.redTeam.light` saying a spec's `review` overrides `kinds` and `maxDiffLines`.
- The plugin changelog.
- Version `0.6.0` in the plugin manifest and the marketplace entry, and anywhere else the existing
  version test checks.

## Not in scope

- A choice at ship time.
- Changing the floor list.
- Removing `roles.redTeam.light.kinds`. It stays the default for specs with no `review` field.
