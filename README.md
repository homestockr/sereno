<p align="center">
  <img src="build/logo-full.png" alt="Sereno" width="220">
</p>

<p align="center">
  An always-on-top widget for every Claude Code session on your machine:<br>
  what it is doing, what it has spent, and — loudest of all —<br>
  whether it is sitting blocked waiting for you.
</p>

---

Windows 11 · Node + Electron · no build step, no framework, no deps beyond Electron.

```
┌──────────────────────────────────────────┐
│ ◉ Sereno              ⠿      −  +  ×     │
│                                          │
│  (!)  One session needs you.             │   ← amber banner, breathing beacon
│       Waiting for approval               │
├──────────────────────────────────────────┤
│ api-worker                  Waiting 00:34│
│ Bash command requested                   │
│  ┌────────────────────────────────────┐  │
│  │ › rm -rf ./dist                    │  │
│  └────────────────────────────────────┘  │
│  [ Review in terminal                ↗ ] │
│  ▬▭▭ Context 12%              $0.53 est. │
├──────────────────────────────────────────┤
│ homestockr                  ▮▮▮ Running  │
│ Bash · npm run build        +2 subagents │
│  ▬▬▭ Context 34%             $1.88 est.  │
├──────────────────────────────────────────┤
│ 61% used                  5-hour session │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭▭▭▭                     │
│ Resets in 1h 40m                         │
│ 44% used                    7-day weekly │
│ ▬▬▬▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭▭▭                     │
│ Resets in 4d 02h                         │
│                      $17.47 list-price   │
└──────────────────────────────────────────┘
```

**State is carried by shape, not colour** — an equalizer for running, a dotted ring
for thinking, a hollow ring for idle, a dashed rule for stale. That survives a
daltonized theme and a glance from across the room; a coloured dot does not. The
one interruption that matters gets warm amber rather than alarm red.

## Install

**From a build** — run `Sereno-Setup-<version>.exe`, or unzip
`Sereno-<version>-win-portable.zip` somewhere permanent and run `Sereno.exe`. On first
launch it offers to connect itself to Claude Code; no Node required. The installer
is unsigned, so SmartScreen will warn — see
[docs/distributing.md](docs/distributing.md).

The installer is per-user, lets you choose the directory, and creates Start Menu
and desktop shortcuts. It registers an uninstaller under **Settings → Apps →
Installed apps**, which disconnects Sereno from Claude Code before removing
anything — dead hook paths would otherwise fire on every tool call forever.

### Pinning to the taskbar

Right-click **Sereno** in the Start Menu (or its desktop shortcut) and choose
**Pin to taskbar**. Clicking the pinned icon starts Sereno, or brings the widget
back to the front if it is already running.

The widget itself never takes a taskbar button of its own: it is an always-on-top
HUD, so it deliberately stays out of both the taskbar and Alt+Tab. The pin is a
launcher, and will not show a running indicator.

Pinning depends on the app and its shortcuts agreeing on one AppUserModelID —
`com.sereno.widget`, set from `build.appId`, which the installer stamps onto every
shortcut and `src/main.js` claims at startup. Windows keys toast notifications off
the same identity, so if the two ever drift apart, pinning *and* every alert break
together. Change one and you change the other.

### Starting automatically

Off by default. Open the **⚙** menu in the widget and tick **Start Sereno
automatically** to have it open whenever a Claude Code session begins.

It works through the `SessionStart` hook Sereno already installs: when that hook
fires and finds nothing listening, the shim starts the app and hands it the event
that triggered the launch, so the widget comes up with the session already on it
rather than empty. Only `SessionStart` may do this, and only one launch is allowed
per 20-second window — otherwise opening four terminals at once would start four
copies. The setting needs Sereno connected to Claude Code, since without the hook
there is nothing to start it.

**From source:**

```sh
npm install
npm run wire      # merges into ~/.claude/settings.json, backing it up first
npm start
```

Restart any running Claude Code session afterwards so it picks up the new settings.

`npm run wire` is a merge, not an overwrite: existing hooks are preserved, and an
existing `statusLine` is printed and confirmed before it is replaced. Running it
twice does nothing. `npm run unwire` restores the most recent backup byte for byte.

| script | what it does |
|---|---|
| `npm start` | the widget |
| `npm run serve` | collector only — open `http://127.0.0.1:8787/` in a browser tab |
| `npm test` | 70 acceptance + regression tests, no GUI needed |
| `npm run replay` | replays `samples/*.jsonl` through the state machine |
| `npm run wire` / `unwire` | install / uninstall (`--dry-run`, `--yes`, `--list`) |
| `npm run dist` | build the Windows installer + zip |
| `npm run test:packaged` | verify the built shim runs without Node |

## Sizing

The widget scales for the display you actually have.

| | |
|---|---|
| **Zoom** | the `−` / `+` buttons, `Ctrl +` / `Ctrl -`, `Ctrl 0` to reset, or `Ctrl`+scroll |
| **Width** | drag the grip in the bottom-right corner |
| **Height** | automatic — it follows the content |
| **Move** | drag anywhere on the header |

Zoom steps are discrete (0.8 → 2.5) so every stop lands on a crisp pixel grid.
Position, width and zoom persist to `%APPDATA%/sereno/window.json`.

## How it works

```
Claude Code session ──┐
Claude Code session ──┼── spawns ──> bin/emit.js ──HTTP──> 127.0.0.1:8787
Claude Code session ──┘               (per event)              │
                                                               ├─ collector
                                                               ├─ session store
                                                               └─ SSE ─> renderer
```

`bin/emit.js` is the shim every hook and the statusline invoke. It is the only
piece that sits in Claude Code's critical path, so it exits 0 on every path —
collector down, EPIPE, malformed JSON, empty stdin — caps its request at 250 ms,
never writes to stderr, and always prints exactly one line in statusline mode.
Since it takes over your statusline, it renders a useful one:

```
Opus 5  ·  34% ctx  ·  $2.41 est.  ·  58% limit
```

## What discovery changed

`docs/payloads.md` records the real payloads from Claude Code 2.1.270. Findings
that contradicted the original spec and changed the build:

**Subagents share the parent's `session_id`.** Subagent tool calls arrive tagged
with `agent_id` but under the parent session. Applied as written, the spec's state
machine let a subagent's `Bash` overwrite the parent row, and a subagent's
`PostToolUse` clear a blocked parent. Only untagged events drive top-level state.
There is also no `SubagentStart` event, so the spec's decrement-only counter had
nothing to increment it; the count is the size of a live `agent_id` set.

**`Notification` does not name the tool.** Its `message` is the fixed string
"Claude needs your permission". The command shown in the alert block is derived —
the last `PreToolUse` with no matching `PostToolUse`. It does carry a structured
`notification_type: "permission_prompt"`, a better discriminator than a text match;
the text match is kept as a fallback for unknown types.

**Rate limits are real, and there are exactly two.** The statusline carries
`rate_limits.five_hour` and `.seven_day`, each with `used_percentage` and
`resets_at`. The footer meters both, separately. Collapsing them to whichever was
higher hid the other one, and the other one is precisely what you want to see
before starting something long.

**There is no per-model allowance in the payload.** The desktop app shows a weekly
figure for Opus/Fable; nothing in any hook or statusline payload carries it, and
neither cost nor `model.display_name` can be used to derive it. Sereno shows the
two windows it is actually given rather than a third one it would have to invent.
An unrecognised window renders on its own row, so if that figure ever does arrive
it appears instead of being silently dropped.

No hook payload carries cost, model or context — all of it comes from the
statusline, which is why wiring the statusline matters as much as the hooks.

**Percentages are dirty floats.** A live session returned `57.99999999999999`,
which rendered verbatim in the header and in the user's own statusline until every
percentage was rounded at the source. The captured samples all happened to hold
whole numbers, so replaying them would never have caught it.

**`process.ppid` is not the session.** Hooks run through a transient shell that has
already exited by the time the widget could use its pid. `CLAUDE_PID` is exported
into the hook environment, is stable, and is free to read — that is what makes
"Review in terminal" possible. `claude.exe` owns no window, so the terminal is
found by walking up the process tree to the first window handle.

## Known limits, stated honestly

- **The toast is ~8 s behind the prompt.** Measured: `PreToolUse` at 23.1 s,
  `Notification` at 31.4 s, with the permission prompt on screen the whole time.
  Sereno reacts within ~2 s of the `Notification`, but Claude Code emits that event
  about eight seconds after it actually blocks. Inferring "blocked" from a stalled
  `PreToolUse` instead would light up on every slow `npm install`, which is worse.
- **Cost is a list-price estimate, not a bill**, and is labelled as one throughout.
- **`PreCompact` is untested.** No session in discovery came near the context
  limit, so the `compacting` state is written to spec and never seen live.
- **Idle notifications are unobserved.** Only `permission_prompt` has ever been
  seen, so only it raises the alert — an unknown type must not, or Sereno cries wolf.
- **~135 ms of shim overhead per event** on this machine, on top of the ~345 ms
  Node process start that any statusline command pays regardless.
- **"Review in terminal" focuses the terminal, not the prompt.** Approval always
  happens in Claude Code; the button only brings that window forward, and says so
  if it cannot find one. Every blocked session carries its own button, because
  only one of them can be promoted into the alert block at a time.
- **Which window it brings forward is decided by title.** Windows Terminal hosts
  every window it has opened inside one process, so `.MainWindowHandle` names an
  arbitrary one and every session used to raise the same terminal. Sereno now
  enumerates that process's windows and matches the target's console title, read
  by attaching to its console — never by reading the transcript. A terminal that
  sets no distinct title per session cannot be disambiguated this way, and falls
  back to raising the first window it owns.

## Distributing

See [docs/distributing.md](docs/distributing.md). The short version: a packaged
Sereno must not assume Node exists, because Claude Code itself doesn't — so the
shim runs through Electron with `ELECTRON_RUN_AS_NODE`, measured at 171 ms per
invocation. The uninstaller disconnects from Claude Code before removing files,
because dead hook paths would otherwise fire on every tool call forever. Builds
are unsigned and will trip SmartScreen until you add a certificate.

## Privacy

Sereno moves no data off the machine it runs on.

The collector binds to `127.0.0.1` only and is never exposed to the network.
Session state — project name, tool being run, cost, context, rate limits — is held
in memory for as long as the session is alive and is never written to disk, never
transmitted, and never sent to any third party. Transcripts are not parsed. The
only files Sereno writes are its own window position (`%APPDATA%/sereno`), its own
settings (`~/.sereno` — the auto-start preference and the command used to start
itself) and, when you connect it, its entries in Claude Code's `settings.json`.

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.

Sereno can be removed completely. **Disconnect** in the widget removes its
statusline and hooks and leaves the rest of your settings alone; `npm run unwire`
restores the pre-install backup instead; and the uninstaller disconnects for you.
Entries it cannot prove are its own are reported, never deleted.

## Code signing policy

Free code signing on Windows is provided by [SignPath.io](https://about.signpath.io/),
with a certificate from the [SignPath Foundation](https://signpath.org/).

Roles, as a solo project:

- **Author / committer** — [@homestockr](https://github.com/homestockr)
- **Reviewer** — [@homestockr](https://github.com/homestockr); external contributions
  are reviewed before merge
- **Approver** — [@homestockr](https://github.com/homestockr); every signed release
  is approved manually

Released binaries are built from source by GitHub Actions
([`.github/workflows/build.yml`](.github/workflows/build.yml)), not on a developer
machine.

> **Current status:** the code signing application is pending, so the binaries on
> the releases page are **unsigned** and Windows SmartScreen will warn. See
> [docs/distributing.md](docs/distributing.md).

## License

[MIT](LICENSE) © 2026 Roberto Rosado

## Layout

```
bin/emit.js             the shim; must never break Claude Code
src/main.js             Electron main: window, zoom, toast, lifecycle
src/collector.js        node:http server — /hook /status /events /state /
src/store.js            session state machine
src/config.js           Sereno's own settings; the app/shim auto-start contract
src/renderer/           the widget page (works in a plain browser tab too)
src/focus-window.ps1    walks the process tree to raise a session's terminal
tools/wire.js           install / uninstall
tools/test.js           acceptance tests
tools/dump.js           discovery probe
docs/payloads.md        the real payload contract
samples/*.jsonl         57 captured records
```
