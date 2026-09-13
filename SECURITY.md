# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅        |
| < 1.1   | ❌        |

Fixes land on the latest release; older versions are not backported.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- **Preferred:** [Report a vulnerability](https://github.com/homestockr/sereno/security/advisories/new)
  via GitHub's private advisories
- **Email:** roberto.d.rosado@gmail.com

Expect an acknowledgement within a few days. If the report is valid you will be
credited in the release notes unless you would rather not be.

## What Sereno touches

Worth stating plainly, because Sereno asks for more trust than a widget usually
does:

- **It edits `~/.claude/settings.json`**, adding a statusline and nine hook
  entries. Those commands are executed by Claude Code on every tool call. It backs
  the file up before writing, merges rather than overwrites, and removes only its
  own entries on uninstall.
- **It runs inside the critical path of every Claude Code session.** `bin/emit.js`
  exits 0 on every failure path and caps its request at 250 ms specifically so a
  broken Sereno cannot take Claude Code down with it.
- **It opens a local HTTP server** on `127.0.0.1:8787` (`GET /`, `/state`,
  `/events`; `POST /hook`, `/status`). It binds to loopback only and never
  listens on an external interface.

  It is **not authenticated**: any process already running as your user can post
  events to it or read session state. That is the deliberate threat model —
  Sereno trusts the local user, who could read the same data from the transcript
  files anyway.

  What it does *not* trust is the browser. Requests are rejected unless the
  `Host` header is a loopback name, which blocks DNS-rebinding (a hostname
  pointed at `127.0.0.1` would otherwise let a web page read every session's cwd
  and commands same-origin), and unless any `Origin` header is our own, which
  blocks the cross-origin `text/plain` POST that could otherwise inject sessions
  and fire fake permission alerts. `POST` additionally requires
  `application/json`, which cannot be sent cross-origin without a preflight that
  is never granted. No CORS headers are ever emitted, so a foreign page cannot
  read a response even if it manages to send a request.
- **It spawns `powershell.exe`** for one narrow purpose — walking the process tree
  to bring a session's terminal to the front (`src/focus-window.ps1`). The only
  value passed in is a process id, as an argument, never interpolated into a shell
  string.
- **It reads hook and statusline payloads**, which contain prompt text, file paths
  and tool arguments. These stay in memory, are never written to disk, and are
  never transmitted. See the privacy section of the README.

## Out of scope

- Requiring physical or local-user access beyond the above — Sereno trusts the
  local user by design.
- SmartScreen warnings on unsigned builds. These are expected and documented in
  [docs/distributing.md](docs/distributing.md); code signing is pending.
