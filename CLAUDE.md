# Sereno

Local, open-source observability for Claude Code. v1.3.1 is a shipped Windows widget
(live sessions, "needs you" alerts, subagents, cost, rate limits, tray). We are
evolving it into a full observability tool **in this codebase**: no rewrite.

- Spec (source of truth for direction): https://claude.ai/code/artifact/f32ab64f-98e9-41e3-93e9-5eca4781e3ce
- Payload contract (source of truth for data): `docs/payloads.md`. Where the spec and
  captured data disagree, the data wins.
- Design baseline: `docs/design/console/` (mockups + rules they settle).
- Repo: https://github.com/homestockr/sereno (work on feature branches, merge to `main`)

## How Robe wants to work

- Keep updates short and to the point. Lead with the answer; offer detail, don't dump it.
- Ask before pushing, merging, publishing a release, or touching `~/.claude/settings.json`.
- Run an independent review before merging anything non-trivial; insufficient context
  is never a pass.

## Working in Claude Code (roles)

Start the main session on Opus from the repo root (`claude --model opus`). It is the
**architect**: it plans, decides, reviews diffs and commits. It does not write feature code.

| Role | Agent | Model | Use for |
|---|---|---|---|
| Architect | main session | opus | Plans in `docs/plans/`, reviewing Builder diffs, commits |
| Builder | `builder` | sonnet | One plan step at a time: code + its tests, `npm test` green, no commits |
| Scribe | `scribe` | haiku | Release notes, briefs, changelog, PR text |
| Red team | `red-team` | fable | Read-only adversarial review of `main...<branch>` before merge |

Loop per step: architect hands the Builder one step → reviews the diff → architect commits
on the feature branch. Before merge: red team on the whole branch; `block` or
`needs-context` means fix and re-run, not merge.

Keep it lean (decided 2026-10-18, token efficiency):
- One Builder run per fix. Bundle every known point into it; don't send follow-ups one at a time.
- The architect writes one-line commit messages. The Scribe is for release notes, PR text,
  changelogs and briefs.
- One red-team pass per branch, not per fix. Fold its lows into one follow-up commit on the same
  branch before merging. Re-run the red team only if that commit is non-trivial.
Agents live in `.claude/agents/`; change a role's model there.

Working notes:
- Look at UI work in a browser before committing it. Tests check markup, not layout. Serve
  the working tree on a spare port with `node tools/serve.js 8790`, never 8787 or 8797,
  because the installed app runs on 8787.
- Stop that server before running `npm test`, never in the same batch of tool calls.
  Stopping it mid-run kills the suite with exit 127.
- Builders on Windows sometimes write CRLF or raw control bytes. Scan diffs for bytes
  0x00-0x08, 0x0e-0x1f and 0x7f before committing. `.gitattributes` normalises line endings.
- A privacy canary in `tools/test.js` forbids `console.js` from reading `.text` or
  destructuring `text`. Don't work around it; rename the field instead.

## Commands

```sh
npm install
npm test            # GUI-free suite (785 tests, several minutes); CI runs it on every push/PR
npm start           # the widget
npm run serve       # collector only, http://127.0.0.1:8787/
npm run wire        # install hooks + statusline (merges, backs up first)
npm run unwire      # restore the backup byte for byte
npm run replay      # replay samples/*.jsonl through the state machine
npm run dist        # Windows installer + zip
```

## Invariants: do not break

- **`bin/emit.js` must never break Claude Code.** Exit 0 on every path, cap requests at
  250 ms, never write to stderr, always print exactly one line in statusline mode.
- **Keep the command shim.** Do not switch to HTTP hooks: the shim reads `CLAUDE_PID`
  (for "Review in terminal") and auto-launches on `SessionStart`.
- **No runtime dependencies beyond Electron.** Planned exceptions only: `uPlot` vendored
  as one file for charts. SQLite comes from the built-in `node:sqlite`.
- **Collector stays on `127.0.0.1:8787`** with its Host/Origin checks. Not 4318.
- **Only untagged events drive top-level session state.** Subagent events arrive under
  the parent `session_id` with `agent_id`.
- **Only `notification_type: permission_prompt` raises "needs you".** Unknown types never alert.
- **Round every percentage at the source** (live payloads return `57.99999999999999`).
- **Privacy:** never parse transcripts; never store prompts, responses, commands or tool
  inputs on disk; ingest is allowlist-based; drop `user.*` / `organization.id` at ingest;
  wiring never sets `OTEL_LOG_*` content flags. `samples/*.jsonl` hold real data:
  never commit them or copy them into fixtures.
- **Every dollar figure is labelled an estimate.**
- **Sereno observes; it never acts.** The only action is "Review in terminal".
- Windows first. Say so plainly; don't add platform code speculatively.
- Every change adds its own tests in `tools/test.js`.

## Layout

```
bin/emit.js              hook + statusline shim
src/main.js              Electron main: window, tray, toasts, lifecycle
src/collector.js         node:http: /hook /status /events /state /v1/* /api/* /console
src/store.js             live session state machine (in memory)
src/config.js            ~/.sereno settings, auto-start contract
src/wiring.js            install/uninstall into ~/.claude/settings.json; pluginStatus (read-only)
src/otlp.js              OTLP logs/traces ingest (allowlist)
src/ledger.js            SQLite spend ledger (node:sqlite); role spend at query time
src/projects.js          ~/.sereno/projects.json registry (hide, pin)
src/repos.js             repo poller: git state, briefs, commits, pipeline views
src/briefs.js            hardened brief reader
src/pipeline.js          reads the plugin's .sereno records; requires plugin/bin/lib rules
src/pipeline-alerts.js   "Review needs a decision" / stall state machine
src/renderer/            widget page (also works in a browser tab)
src/renderer/console/    console: Projects, Spend, Pipeline tabs (navy theme tokens)
plugin/                  the Sereno Claude Code plugin (marketplace at .claude-plugin/)
templates/agents/        agent templates
tools/test.js            the suite
docs/payloads.md         captured payload contract (Claude Code 2.1.270, re-probed 2.1.289 in §6)
docs/plans/              one plan per phase or release; the Builder works from these
docs/design/console/     console + widget mockups (older ones predate the navy theme)
```

The app bundles exactly four plugin modules (`recovery.js`, `config.js`, `records.js`,
`fsafe.js`) plus the plugin's agent and skill files (`package.json` `build.files`). A test
checks that list.

## Roadmap

1. **Spend ledger (shipped `2.0.0-alpha.1`).** Plan: `docs/plans/phase-1-ledger.md`.
2. **Spend in view (shipped `2.0.0-alpha.2`).** Plan: `docs/plans/phase-2-spend-in-view.md`.
3. **Projects + briefs (shipped `2.0.0-alpha.3`).** Plan: `docs/plans/phase-3-projects-briefs.md`.
4. **Pipeline, in two parts.** Decided 2026-10-13: a standalone Claude Code plugin owns
   everything that acts; the app only observes the files it writes.
   - 4a, the plugin (`plugin/`, marketplace at the repo root), shipped in `2.0.0-alpha.4` as
     plugin `0.1.0`: plan `docs/plans/phase-4a-plugin.md`. Then:
     - plugin 0.2.0: Sonnet orchestration and `/sereno:merge` (`docs/plans/phase-4a-cost.md`);
     - plugin 0.3.0: model tier aliases (`docs/plans/plugin-0.3-model-aliases.md`);
     - plugin 0.3.1: Builders get a fixed tool list, skills guard against other plugins' skills
       (step A0 of `docs/plans/plugin-0.4-next.md`).
   - 4b, the app side (Pipeline tab, role spend, pipeline alerts, offer the plugin): merged.
     Plan: `docs/plans/phase-4b-pipeline-view.md`, including its one-screen layout addendum.
5. **alpha.6 (shipped `2.0.0-alpha.6`, 2026-10-25; alpha.5 skipped).** Phase 4b plus the navy
   theme, the Projects navigator, the Spend redesign and the Pipeline restyle. Plan:
   `docs/plans/alpha6-projects-navigator-theme.md`. Known follow-up: the Pipeline tab layout (an
   empty main area, a cramped right panel that clips, paths that wrap mid-word). Fix it with
   alpha.7.
6. **Sessions tab (planned, `2.0.0-alpha.7`).** Brief, concept and data decision (new
   `session_events` table: tool names, permission waits, prompt counts, timings, never
   inputs): `docs/plans/alpha7-sessions.md`.
7. **Plugin 0.4.0 (planned).** `/sereno:next` runs build and ship in one turn and stops at the
   first human gate. It adds holds, queued tasks (`--after`) and token-efficiency work:
   - a review sized to the task;
   - bookkeeping done in code;
   - the leak proven gone;
   - a review pack for the red team;
   - cost shown in the app.
   Plan: `docs/plans/plugin-0.4-next.md`.
8. **Plugin 0.5.0 (planned, after 0.4.0).** Lessons from Anthropic's harness-design article:
   - runnable acceptance checks in specs (cmd, http, browse);
   - a spec review before larger builds;
   - stub detection in the review pack;
   - escaped-defect measurement per reviewer, in the app with alpha.8.

   Plan: `docs/plans/plugin-0.5-harness.md`.

Open: Dependabot #33 (`sprintf-js`, dev-only, no fix released yet). The v1.3.x draft release
is undecided.

### Phase 1 notes

- `node:sqlite` works in Electron 44.3.0 (Node 24.20, SQLite 3.53), WAL and
  checkpoint-then-close. `npm run serve` needs Node >= 22.13. Still confirm once in a
  packaged Windows build (plan step 7).
- 2.1.289 re-probe (`docs/payloads.md` §6): `SubagentStart` exists; hook `agent_id` ==
  span `agent_id`; spans join `api_request` on `request_id`; statusline cost lags the ledger.
- v1.3.1 fixed background subagents (`Stop.background_tasks` is authoritative);
  `wiring.js` registers `SubagentStart`.

## Key decisions (2026-10-04)

- Evolve v1.3.x (plain JS, JSDoc + `// @ts-check` for new modules) instead of a TS rebuild.
- Statusline stays the live cost source; the ledger is the record; reconcile, don't assume.
- Role attribution is `explicit` (trace span links request to agent), `inferred`
  (timing or unique model) or `unknown`, stored with a config snapshot per run.
- A gate `block` alone is not an alert; alert on stalled repair, retry limit, or a decision.
- Merge requires passing tests and a gate `pass` (or `skipped` when the gate is off).
- Console tabs: Projects (default), Spend, Pipeline, Sessions. The widget stays the "now" view.
- Versioning: 2.0.0 when the console ships; alphas before that.

## Later decisions

- **Attribution, as built.**
  - `explicit`: an agents join supplies the agent type.
  - `inferred`: only for a request with no known agent type, and only when its model family is
    used by exactly one role across the plugin's agent and skill files. Today that means only
    Fable, for the red team.
  - Main session and auxiliary spend stay their own buckets. The Pipeline tab counts only the
    Builder, Red team and Scribe.
- **Plugin models are tier aliases** (`haiku`, `sonnet`, `opus`, `fable`), not pinned IDs.
  - Claude Code has no supported way for a plugin to set a model from config at runtime, and
    the plugin cache is replaced on every update.
  - Users repoint a tier with `ANTHROPIC_DEFAULT_<TIER>_MODEL`, which applies to all of
    Claude Code.
  - `roles.builder.allowed` restricts Builder tiers, enforced with exit 21.
  - The app matches models by family (`modelFamily`).
- **The Builder is chosen per task in the spec.** The default is Sonnet; Haiku is for
  mechanical work, Opus for work needing judgment.
- **Theme.** Navy palette in `:root` tokens in `console.css` and `app.css`.
  - `--accent` marks selection and focus.
  - Amber only for "needs you" or a pending decision.
  - Tests check contrast and that no hex colour sits outside the tokens.
- **Cost.** The app's Cache view shows token shares only. There is no savings figure, because
  the ledger stores no prices.
- **Pinning and hiding** are Sereno's own config in `projects.json`, not actions on a repo.
