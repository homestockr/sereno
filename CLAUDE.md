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
| Scribe | `scribe` | haiku | Commit messages, briefs, changelog, PR text |
| Red team | `red-team` | fable | Read-only adversarial review of `main...<branch>` before merge |

Loop per step: architect hands the Builder one step → reviews the diff → Scribe drafts
the commit message → architect commits on the feature branch. Before merge: red team
on the whole branch; `block` or `needs-context` means fix and re-run, not merge.
Agents live in `.claude/agents/`; change a role's model there.

## Commands

```sh
npm install
npm test            # GUI-free suite (113 tests); CI runs it on every push/PR
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
bin/emit.js            hook + statusline shim
src/main.js            Electron main: window, tray, toasts, lifecycle
src/collector.js       node:http: /hook /status /events /state /
src/store.js           live session state machine (in memory)
src/config.js          ~/.sereno settings, auto-start contract
src/wiring.js          install/uninstall into ~/.claude/settings.json
src/renderer/          widget page (also works in a browser tab)
tools/test.js          the suite
docs/payloads.md       captured payload contract (Claude Code 2.1.270, re-probed 2.1.289 in §6)
docs/plans/            one plan per phase; the Builder works from these
docs/design/console/   console + widget mockups
```

Planned (spec): `src/otlp.js`, `src/ledger.js`, `src/repos.js`,
`src/renderer/console/`, `templates/agents/`, `templates/commands/`.

## Roadmap

1. **Spend ledger (in progress).** Plan: `docs/plans/phase-1-ledger.md`.
   Branch `feat/otlp-ledger`, ships as `2.0.0-alpha.1`.
2. **Spend in view.** Widget footer total; console Spend tab.
3. **Projects + briefs.** Repo poller; per-branch briefs in `.sereno/briefs/`.
4. **Pipeline.** `pipeline.json` (configurable models per role, presets, fallback
   policy), agent templates, `/ship`, gate files in `.sereno/gates/<review_run_id>.json`.

Exploring: shipping the Phase 4 pipeline as a Claude Code plugin (agents, `/ship`
skill, gate-writing hooks) so it works without the app; the app then observes the
gate and brief files the plugin writes. Not started; decide before Phase 4.

### Phase 1 notes

- `node:sqlite` works in Electron 44.3.0 (Node 24.20, SQLite 3.53), WAL and
  checkpoint-then-close. `npm run serve` needs Node >= 22.13. Still confirm once in a
  packaged Windows build (plan step 7).
- 2.1.289 re-probe (`docs/payloads.md` §6): `SubagentStart` exists; hook `agent_id` ==
  span `agent_id`; spans join `api_request` on `request_id`; statusline cost lags the ledger.
- v1.3.1 fixed background subagents (`Stop.background_tasks` is authoritative), but
  `wiring.js` does not register `SubagentStart` yet (plan step 0).

## Key decisions (2026-10-04)

- Evolve v1.3.x (plain JS, JSDoc + `// @ts-check` for new modules) instead of a TS rebuild.
- Statusline stays the live cost source; the ledger is the record; reconcile, don't assume.
- Role attribution is `explicit` (trace span links request to agent), `inferred`
  (timing or unique model) or `unknown`, stored with a config snapshot per run.
- A gate `block` alone is not an alert; alert on stalled repair, retry limit, or a decision.
- Merge requires passing tests and a gate `pass` (or `skipped` when the gate is off).
- Console tabs: Projects (default), Spend, Pipeline, Sessions. The widget stays the "now" view.
- Versioning: 2.0.0 when the console ships; alphas before that.
