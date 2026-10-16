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
│ Agent · audit the wiring module          │
│   Explore    Bash · grep -rn "emit"  0:12│
│   general    reasoning               0:08│
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
one interruption that matters gets warm amber rather than alarm red. The widget and the
console share a navy palette, with a matching light variant that follows your system
setting; amber stays reserved for "needs you" and pending decisions.

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

The command it launches is recorded in `~/.sereno` on every boot, so it follows
the app through an update, a reinstall, or a move. A build that lives somewhere
temporary — a source checkout, or the `dist/` directory the next build
recreates — may seed that slot when it is empty, but never takes it from an
installed copy: running from source once used to silently repoint auto-launch at
a tree that would not be there tomorrow. The slot heals itself when the target
stops existing, so an uninstall or a moved checkout cannot strand it, and the
shim checks the binary is there before it claims anything.

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
| `npm test` | 97 acceptance + regression tests, no GUI needed |
| `npm run replay` | replays `samples/*.jsonl` through the state machine |
| `npm run wire` / `unwire` | install / uninstall (`--dry-run`, `--yes`, `--list`) |
| `npm run dist` | build the Windows installer + zip |
| `npm run test:packaged` | verify the built shim runs without Node |

## Collapsing

The **⌃** button hides the widget to the Windows notification area. The tray
icon carries the state from there, and clicking it brings the widget back.

```
needs you        working         quiet
 amber disc       equalizer       hollow ring
 with a bang        bars
```

It follows the same rule as the session rows: **the mark carries the state and
colour only reinforces it.** A count cannot survive 16 pixels, so the number of
sessions lives in the tooltip instead. There are two sets of marks, one per
taskbar theme — Windows only auto-inverts tray icons on macOS, and measured
against a light Windows 11 taskbar a single light set came out at 1.02:1, which
is to say invisible. Every mark now clears 3:1 against the taskbar it is drawn
for, and `npm test` asserts it.

The icons are drawn by `tools/make-tray-icons.js`, which writes PNGs by hand
through `node:zlib`. Sereno ships no runtime dependencies and adding an image
toolchain to produce three shapes would be a poor trade. The suite runs the
generator and byte-compares its output against the committed files, so the two
cannot drift apart.

> **Windows will hide it at first.** Windows 11 files an unfamiliar tray icon
> into the overflow behind the **⌃** arrow, and an application cannot promote
> itself out of it — there is no API for that, by design. Drag Sereno out of the
> overflow once and it stays. Sereno says so in a notification the first time it
> hides, but only once.

The tray icon is created at startup and lives for as long as the app does,
rather than appearing and disappearing with the widget: Windows treats a
re-created icon as a new one and can file it back into the overflow, so a tray
that came and went would need rescuing every time. It also means there is always
a way back if the window ends up somewhere unreachable.

While hidden, the widget announces nothing to a screen reader — the permission
toast is the only accessible notification in that state, and it fires only when
a session first blocks.

## Spend history (alpha)

An optional local record of what each Claude Code request cost. Off by default.
**First launch offers to enable it.** You can turn it on or off later in the tray
menu ("Keep spend history").

Spend is split by source (main thread, subagent, auxiliary) until roles arrive in a later release.

Spend is recorded only while Sereno is running. Telemetry sent while it is closed is
not kept, so leave "Start Sereno automatically" on.

**What is stored.** `%USERPROFILE%\.sereno\sereno.db` (or `$SERENO_HOME`), SQLite.
Per request: `request_id`, session and prompt ids, timestamp, model, query source
(main thread, subagent, session title, ...), token counts, cost estimate, duration,
which agent and how that was determined. Per session: the working folder path (shown as
the project name), the model, and the last statusline cost. Per subagent: its id, type,
and start/stop times. Rows older than 90 days are pruned each time Sereno starts. **Never stored**: prompts, responses, code,
commands, tool inputs, your email, account ids, or organization ids. All dropped at
ingest.

### In the widget

A "Today · estimated usage" block appears under the usage windows: today's estimated total, a line from local midnight to now, and a bar split into Main, Subagent and Auxiliary, with unattributed spend hatched grey. Requires spend history on and telemetry from Claude Code. Until telemetry arrives it says "Waiting for telemetry from new Claude Code sessions"; with spend history off the footer is exactly as before. The existing `$X.XX list-price est.` line shows the live statusline total of the sessions on screen — a different number. "Open console ↗" in the footer (and "Open console" in the tray) opens the console in your browser.

### Console

`http://127.0.0.1:8787/console`, local only. The **Spend** tab has four sub-tabs (the route keeps them, e.g. `#spend/projects`):

- **Overview**: today and month-to-date totals with the unattributed share, and usage cost by source as stacked bars for 24 hours (hourly), 7 or 30 days.
- **Projects**: where the spend goes, project by source (main, subagent, auxiliary), each with a 14-day trend; the rest fold into "Other projects".
- **Turns**: the costliest turns by time, project, session id, cost, models and attribution. Prompt text is never stored, so it never appears.
- **Cache**: cache read, cache write and uncached input as shares of tokens. Token shares only; there is no savings figure.

The side panel shows the selected project: month-to-date total, source breakdown, the attribution mix with its n, and a 14-day trend. "View project" jumps to it in Projects. Every dollar figure is an estimate. An attention panel turns amber only when a session is waiting on a permission prompt, telling you to answer it in the terminal.

**Telemetry.** The ledger needs Claude Code's OpenTelemetry logs exported to Sereno
at `http://127.0.0.1:8787`. Offered as a **separate confirmation** after you enable
spend history, because it edits `~/.claude/settings.json`. Or run:

```
npm run wire -- --telemetry
```

This sets:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8787
OTEL_TRACES_EXPORTER=otlp
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
```

Never sets any `OTEL_LOG_*` content flag (user prompts, tool details). **Conflict rule:**
if any of these keys already holds a different value, or any other `OTEL_*` key is
set (you send telemetry elsewhere), Sereno changes nothing and tells you which keys
conflict. Merge them yourself or
move your telemetry, then wire again.

**Turning it off.** Tray toggle stops recording immediately. To remove the telemetry
env keys, use "Unwire telemetry" in the tray, or:

```
npm run unwire -- --telemetry
```

(removes only keys Sereno set; ones you edited stay). Plain `npm run unwire` restores
the newest `settings.json` backup byte for byte; if you wired both hooks and telemetry,
run it twice to undo both.

To erase all history, quit Sereno, then delete `sereno.db`, `sereno.db-wal` and
`sereno.db-shm`.

Every dollar figure is an estimate, not a bill. The ledger records Claude Code's own
cost estimate.

**Requires Node ≥ 22.13** for `npm run serve` (built-in `node:sqlite`).

## Projects and briefs (alpha)

The console opens on **Projects**, at `http://127.0.0.1:8787/console`. Every git repo a
Claude Code session runs in appears there by itself. A worktree counts as its repo, not as
a second project. Hidden projects are not polled.

**The navigator.** A list on the left, the selected project in detail on the right. Filter chips
(**All**, **Active**, **With blockers**, each with a count) sit above a search box (name and path)
and a sort menu (Pinned first, Recent, Name). Active is the default: a project is active when it
has a live session, a commit in the last 14 days, or a pipeline task that has not expired.
The rest fold into a collapsed **Inactive** group, so 90 repos stay usable. Pin a project with the
pin on its row; pins live in `~/.sereno/projects.json` and are Sereno's own setting, not a change
to the repo. **Manage projects** (top right) hides and unhides. Arrow keys move through the list.

The detail shows the brief (Now, Next, Blocked, with its freshness), a 14-day spend sparkline
labelled `est.`, and tabs for branches, recent activity (commit subjects, brief updates and
pipeline events, kept in memory only) and git and PRs. With no brief it offers **Copy
/sereno:brief**.

**Briefs.** A brief is `.sereno/briefs/<branch>.md` in a repo: front matter, then three
lines, `Now:`, `Next:` and `Blocked:`. The `/` in a branch name becomes `%2F`, so `feat/x`
is `feat%2Fx.md`. The `/brief` command in Claude Code writes it. Sereno never writes to your
repos; it only reads briefs.

The app no longer installs `/brief`. The Sereno plugin provides `/sereno:brief`; the widget's
settings panel shows the two install commands. An older app-written `~/.claude/commands/brief.md`
can be removed from the same panel (after a confirmation), or with `npm run unwire -- --commands`;
either deletes it only if it is unchanged.

**Freshness** compares a brief with its branch:

- **fresh**: no commit on the branch since the brief's `source_commit` touches anything
  outside `.sereno/` and `STATUS.md`.
- **behind**: such a commit exists. Commits that touch only `.sereno/` or `STATUS.md` never
  make a brief behind.
- **stale**: the oldest such commit is more than a day old.
- **No brief**: the branch has no brief file.
- **Brief source not found**: the brief's `source_commit` is not in this repo.

**What Sereno reads from your repos.** Branch names, commit times and hashes (the hashes
stay inside the app), ahead and behind against the default branch's upstream, an
uncommitted-changes flag, the worktree list, and the brief files. Never commit messages,
diffs or other file contents. Between full checks (at most 5 minutes) Sereno may not notice
uncommitted edits, a fetch, or a new branch in a subfolder.
The list of projects, with each repo's path, is kept in `~/.sereno/projects.json`.

Sereno uses read-only git commands, mostly plumbing (rev-parse, for-each-ref, rev-list,
cat-file, symbolic-ref, config, worktree list), plus `status` for the uncommitted-changes
flag. It never runs a network git command itself, never prompts, and only reads repos on
local drives.

**Threat model.** Sereno defends against what a clone or an archive's working tree can
deliver: `.gitattributes` and content filters, submodules, symlinks and junctions, branch
and ref names, brief files, huge files and names shaped like options. Content-filter
drivers are blanked for `status`, the only call Sereno makes that can run them, and
submodules are never entered (`--ignore-submodules=all`). On top of that it adds defence in depth for a
repo's `.git` config: fsmonitor, hooks, signature programs (gpg, ssh and x509), lazy
fetching of missing objects and every transport protocol are switched off. That is not a
guarantee: a repo's `.git/config` is not something Sereno can fully fence off.
Treat a repo's .git folder like you would for git itself: Sereno runs git there with the same trust Claude Code does.

**Projects on network drives or inside WSL are not tracked.** Only local drive-letter paths
(`C:...`) are ever used as a working directory or read, so Sereno does not pass a path a
repo points to on to a share. A mapped network drive letter looks local and cannot be told
apart. Open PR counts come from `gh`, when it is installed and signed in, using only the
GitHub owner and name from `origin`.

**Review in terminal** is in the console's attention panel and in a project's detail when it has a
live session. It raises the session's terminal, as the widget's button does. It is the only
action Sereno offers. It is not available under `npm run serve`.

## Pipeline tab (alpha)

The console's **Pipeline** tab shows the Sereno plugin's work: active tasks on an Architect,
Builder, Red team, Merge track, repairs, tasks that need a decision, the gate state per repo,
and the last 30 days of review outcomes, rework and spend by role. It reads the plugin's
`.sereno/` files in each project and never acts: the plugin does everything that changes a
repo. A task waiting on you raises "Review needs a decision" the way "needs you" does.

Tasks are rows with Plan, Build, Review and Merge, pill sub-tabs, an accent outline on the
selected row, and a row of outcome dots for recent reviews. Amber marks only a task waiting on
your decision.

Every dollar figure is an estimate. Spend by role is split into **explicit** (the request is
linked to a subagent), **inferred** (no link, but the model belongs to one role only) and
**unattributed**. Rates show their n; they describe, they don't grade.

The pipeline is also a Claude Code plugin, so it runs without this app. It gives each task a
gated flow: a spec, a Builder on its own branch, a red-team review with a verdict, tests run
against the base commit, and a merge only after you say yes. Each role has its own model.
Install it inside Claude Code:

```
/plugin marketplace add homestockr/sereno
/plugin install sereno@sereno
```

Without the plugin, the tab and the widget's settings panel show these two commands. The
plugin's `/sereno:brief` replaces the app's old `/brief`, which is retired: the panel offers
to remove an unchanged copy. See [plugin/README.md](plugin/README.md) for the commands,
presets and recovery rules.

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
Claude Code 2.1.270 had no `SubagentStart` event, so the spec's decrement-only
counter had nothing to increment it; current Claude Code sends one, but it is just
the first tagged event, so liveness is still the membership of a live `agent_id`
map (see `docs/payloads.md` §6 for subagents that outlive `Stop`).

Those tagged events carry more than an id. `agent_type` names the agent, and the
subagent's own `tool_name`/`tool_input` say what it is doing, so live subagents
are listed under their parent with what each is running and how long it has been
going. Between its tool calls a subagent reports as reasoning rather than leaving
a finished tool on screen claiming to still be busy. Elapsed time counts from the
first tagged event, since that is the earliest moment a subagent is knowable at
all. A `Stop` that lists no background subagents clears the count and the detail
together; one that does list them keeps those subagents, because they can outlive
the turn.

Three things that only a missing or late event reveals:

- **The map is capped at 32, and the ceiling drops the stalest entry.** The
  entries filling it when the cap bites are the ghosts of subagents whose
  `SubagentStop` never arrived, so rejecting the new arrival instead would keep
  the dead and hide the living. Past 32 concurrent subagents the list is
  necessarily partial.
- **A stopped `agent_id` is remembered for 30 seconds.** The shim is
  fire-and-forget with one connection per hook, so a subagent's last
  `PostToolUse` can arrive after its `SubagentStop`; without the tombstone the
  straggler re-created the entry and a dead subagent reappeared with a clock
  started from that moment. Thirty seconds is long enough to absorb stragglers
  and short enough that a resumed subagent (a new run under the same
  `agent_id`) reappears.
- **The stopwatches stop when the data does.** They hold while the collector is
  unreachable, and a stale session renders no subagent lines at all. They are the
  one element on the page asserting *this is happening right now*, so they must
  not keep climbing off a snapshot that stopped updating.

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
