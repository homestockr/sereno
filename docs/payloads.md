# Observed payloads — Claude Code 2.1.270 (Windows 11)

Captured 2026-09-12 from real sessions via `tools/dump.js`. Raw records in `samples/*.jsonl`
(57 records, 9 event types). **This file, not the build spec, is the contract for the
collector.** Where the spec guessed and the data disagrees, the data wins and the delta is
called out below.

Method: hooks + statusline were wired through `claude --settings <file>` on throwaway
sessions. The user's `~/.claude/settings.json` was never modified.

## How discovery was run (reproducible)

```
node tools/mkprobe.js <out>/probe-settings.json
claude --settings <out>/probe-settings.json ...
```

Two gotchas cost real time and are worth recording:

- A session started in an **untrusted directory** emits *nothing* — the folder-trust prompt
  blocks before `SessionStart`. Probe from an already-trusted cwd.
- `claude -p` (non-interactive) **never invokes the statusline**. Cost, model and context
  are therefore unobtainable from a `-p` session. Statusline data requires an interactive
  session.

---

## 1. Statusline — `statusLine.command`, stdin JSON

The single richest source, and the **only** source of model, cost, context and rate limits.
No hook payload carries any of them.

```json
{
  "session_id": "739821fb-0779-438c-bfe8-0dcfc2111d2f",
  "transcript_path": "C:\\Users\\...\\<session_id>.jsonl",
  "cwd": "C:\\Users\\RobeDev\\desktop\\claude-code-hud",
  "scratchpad_dir": "C:\\Users\\...\\scratchpad",
  "model":         { "id": "claude-haiku-4-5-20251001", "display_name": "Haiku 4.5" },
  "workspace":     { "current_dir": "...", "project_dir": "...", "added_dirs": ["..."] },
  "version": "2.1.270",
  "output_style":  { "name": "default" },
  "cost": {
    "total_cost_usd": 0.0883638,
    "total_duration_ms": 25425,
    "total_api_duration_ms": 20208,
    "total_lines_added": 0,
    "total_lines_removed": 0
  },
  "context_window": {
    "total_input_tokens": 52496,
    "total_output_tokens": 354,
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 8, "output_tokens": 354,
      "cache_creation_input_tokens": 509, "cache_read_input_tokens": 51979
    },
    "used_percentage": 26,
    "remaining_percentage": 74
  },
  "exceeds_200k_tokens": false,
  "fast_mode": false,
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": { "used_percentage": 52, "resets_at": 1789255200 },
    "seven_day": { "used_percentage": 44, "resets_at": 1789462800 }
  }
}
```

Also seen, but **not on every record**: `prompt_cache` (warm, ttl, hit_ratio, …) and
`prompt_id`. Treat every field as optional and read defensively.

### Answers to the three questions the spec asked

| Spec asked | Answer |
|---|---|
| `cost.total_cost_usd`? | **Yes.** Monotonic per session. |
| `context_window`? | **Yes**, with a ready-made integer `used_percentage`. Don't recompute it. |
| `rate_limits`? | **Yes** — `five_hour` and `seven_day`, each `used_percentage` + `resets_at`. |

`rate_limits` existing settles the spec's closing note: **the header's primary figure is
`max(five_hour, seven_day).used_percentage`**, and the dollar figure is secondary and
labelled `est.`. `resets_at` is epoch **seconds** (not ms).

⚠ **`rate_limits.*.used_percentage` is a float, and it is not clean.** A live session
returned `57.99999999999999`, which rendered verbatim in the HUD header and in the user's
own statusline. `context_window.used_percentage` has only ever been seen as an integer but
is the same kind of field, so it is rounded too. Round every percentage before display.
This surfaced only after wiring a real session: the captured samples happened to contain
whole numbers, so the discovery data alone would never have caught it.

### Cadence

22 records, median gap **~1.5 s**, min 0.34 s. It fires on essentially every UI repaint —
so it is a good liveness heartbeat, but the collector must tolerate this rate and the
renderer must not re-layout per record.

**It stops firing while the session is blocked on a permission prompt** (observed 115 s gap).
The blocked timer must therefore run off the HUD's own clock, never off statusline arrivals.

---

## 2. Hook payloads

Every hook carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`; most carry
`prompt_id` and `permission_mode`. `session_id` joins hooks to statusline records — same id,
confirmed across both streams.

| Event | Distinctive fields | Observed values |
|---|---|---|
| `SessionStart` | `source` | `"startup"` (`resume`/`clear` not observed) |
| `UserPromptSubmit` | `prompt` | full prompt text |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, *(`agent_id`, `agent_type`)* | tools seen: Read, Bash, Agent, Skill, Glob, PowerShell |
| `PostToolUse` | + `tool_response`, `duration_ms` | |
| `Notification` | `message`, `notification_type` | see §3 |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path` | |
| `SessionEnd` | `reason` | `"other"` |
| `PreCompact` | — | **never observed**, see Gaps |

---

## 3. `Notification` — the payload the whole app hangs on

```json
{
  "session_id": "739821fb-...",
  "cwd": "C:\\Users\\RobeDev\\desktop\\claude-code-hud",
  "hook_event_name": "Notification",
  "message": "Claude needs your permission",
  "notification_type": "permission_prompt"
}
```

Two things matter, and both contradict the spec.

**(a) There is a structured discriminator.** The spec expected to sniff the message text.
Real payloads carry `notification_type: "permission_prompt"`. Key off that field; keep the
spec's case-insensitive text match on `permission`/`approve`/`waiting` only as a fallback
for unrecognised types.

**(b) The payload does NOT name the tool.** `message` is the fixed string *"Claude needs
your permission"*. The spec's mockup (`Bash: rm -rf ./dist`) cannot be filled from this
event. It must be **derived**: the tool awaiting approval is the most recent `PreToolUse`
for that `session_id` with no matching `PostToolUse` (match on `tool_use_id`).

Observed timeline that establishes this (single session, seconds from session start):

```
23.1s  PreToolUse   tool_name="PowerShell"    <- no PostToolUse ever follows
24.8s  statusline                             <- last statusline; stream then stops
31.4s  Notification notification_type="permission_prompt"
```

### ⚠ Latency finding, affects acceptance criterion 3

`Notification` arrived **8.3 s after** the `PreToolUse` it refers to. The permission prompt
was on screen that whole time. So the HUD can fire its toast within 2 s *of the
Notification*, but that is already ~8 s after the human was actually blocked. Acceptance
criterion 3 ("toast fires within 2s") is satisfiable only when measured from the
Notification, not from the moment of blocking.

---

## 4. Subagents — the spec's model does not survive contact

`Agent` is the tool name (not `Task`). The finding that forces a design change:

```
PreToolUse   tool=Agent  agent_id=(none)              <- parent spawns the subagent
PreToolUse   tool=Bash   agent_id=a54f96d4bbba58643   <- SUBAGENT's own tool call
PostToolUse  tool=Bash   agent_id=a54f96d4bbba58643      agent_type=Explore
SubagentStop             agent_id=a54f96d4bbba58643
```

**Subagent tool calls arrive under the parent's `session_id`**, distinguished only by
`agent_id`. Applied naively, the spec's state machine lets a subagent's `Bash` overwrite the
parent row's `stateDetail`, and the subagent's `PostToolUse` clears a `blocked` parent.

Required rules:

1. Only events **without** `agent_id` may drive top-level `state` / `stateDetail`.
2. Events **with** `agent_id` maintain the subagent map.
3. There is **no `SubagentStart` event.** Liveness is inferred: a previously unseen
   `agent_id` means a live subagent; `SubagentStop` removes it. `subagents` = size of that
   set, which is self-healing — better than the spec's decrement-only counter, which has
   nothing to increment it.

---

## 4b. The hook environment — where the process id actually comes from

No payload identifies the OS process behind a session, which the widget needs in
order to focus a session's terminal. The environment inherited by hooks does:

```
CLAUDE_PID=9204                  <- the long-lived claude.exe for this session
CLAUDE_CODE_SESSION_ID=e5b17ee0-…   matches session_id in the payloads
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_CODE_EXECPATH=C:\Users\…\claude.exe
WT_SESSION=ed3fca13-…            <- Windows Terminal, when that is the host
```

⚠ **`process.ppid` is NOT the session.** Hooks are run through a transient shell
that has already exited by the time the widget could use its pid — measured: every
recorded ppid was already gone on the next tick, and the value changed on every
event. `CLAUDE_PID` is the stable one and is free to read.

`claude.exe` owns no window itself, so the terminal is found by walking up the
process tree until a process with a `MainWindowHandle` appears:

```
claude           pid=9204   window=0
powershell       pid=32028  window=0
WindowsTerminal  pid=28900  window=656696   <- focus this
```

## 5. Gaps — not observed, code defensively

- **`PreCompact`** never fired (no session got near the context limit). Field shape
  unverified; the `compacting` state is written to spec and untested against real data.
- **Idle `Notification`.** A session left idle 95 s produced no notification. Only
  `permission_prompt` has ever been seen. Since other `notification_type` values are
  presumed to exist, **only `permission_prompt` may turn a row red** — an unknown type must
  not, or the HUD cries wolf on idle pings.
- `SessionStart.source` other than `startup`; `SessionEnd.reason` other than `other`.
- `rate_limits` was present on every record of this plan; an API-key account may omit it.
  The header must degrade to the dollar figure when it is absent.
