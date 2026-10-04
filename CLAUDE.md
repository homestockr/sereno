# Sereno

Local, open-source observability for Claude Code. v1.3.0 is a shipped Windows widget
(live sessions, "needs you" alerts, subagents, cost, rate limits, tray). We are
evolving it into a full observability tool **in this codebase**: no rewrite.

- Spec (source of truth for direction): https://claude.ai/code/artifact/f32ab64f-98e9-41e3-93e9-5eca4781e3ce
- Payload contract (source of truth for data): `docs/payloads.md`. Where the spec and
  captured data disagree, the data wins.
- Repo: https://github.com/homestockr/sereno (branches `main`, `dev`)

## How Robe wants to work

- Keep updates short and to the point. Lead with the answer; offer detail, don't dump it.
- Model roles: Opus plans and decides (architect), Sonnet writes code (builder),
  Haiku handles summaries (scribe), Fable runs the adversarial review before merge
  (red team). Delegate implementation to the cheapest model that can do it well.
- Run an independent review before merging anything non-trivial; insufficient context
  is never a pass.
- Ask before pushing, merging, publishing a release, or touching `~/.claude/settings.json`.

## Commands

```sh
npm install
npm test            # GUI-free suite (97 tests today); CI runs it on every push/PR
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
  inputs on disk; ingest is allowlist-based; wiring never sets `OTEL_LOG_*` content flags.
- **Every dollar figure is labelled an estimate.**
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
docs/payloads.md       captured payload contract (Claude Code 2.1.270)
```

Planned (spec): `src/otlp.js`, `src/ledger.js`, `src/repos.js`,
`src/renderer/console/`, `templates/agents/`, `templates/commands/`.

## Roadmap

1. **Spend ledger (next).** `POST /v1/logs` (OTLP/JSON) and optional `POST /v1/traces`
   on 8787; SQLite ledger at `~/.sereno/sereno.db`, opt-in at first launch.
   Exit: replaying the same input leaves totals unchanged; restart preserves spend;
   telemetry without hooks still creates a session; unattributed usage stays unattributed.
2. **Spend in view.** Widget footer total; console Spend tab.
3. **Projects + briefs.** Repo poller; per-branch briefs in `.sereno/briefs/`.
4. **Pipeline.** `pipeline.json` (configurable models per role, presets, fallback
   policy), agent templates, `/ship`, gate files in `.sereno/gates/<review_run_id>.json`.

### Before starting Phase 1

- ~~Test `node:sqlite`~~ Done 2026-10-04: works in Electron 44.3.0 (Node 24.20, SQLite 3.53),
  both as Node and in the main process, with WAL and checkpoint-then-close. No native dep.
  `npm run serve` needs Node >= 22.13 (sqlite unflagged there); it logs an
  ExperimentalWarning, which is fine outside the shim. Still confirm once in a Windows build.
- Re-probe with `tools/dump.js` on the current Claude Code: `SubagentStart` and
  `StopFailure` (not seen in 2.1.270), and whether hook `agent_id` equals the trace
  span `agent_id`.

## Key decisions (2026-10-04)

- Evolve v1.3.0 (plain JS, JSDoc + `// @ts-check` for new modules) instead of a TS rebuild.
- Statusline stays the live cost source; the ledger is the record; reconcile, don't assume.
- Role attribution is `explicit` (trace span links request to agent), `inferred`
  (timing or unique model) or `unknown`, stored with a config snapshot per run.
- A gate `block` alone is not an alert; alert on stalled repair, retry limit, or a decision.
- Merge requires passing tests and a gate `pass` (or `skipped` when the gate is off).
- Console tabs: Projects (default), Spend, Pipeline, History. The widget stays the "now" view.
