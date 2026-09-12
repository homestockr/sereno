# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |

Sereno is pre-1.1; fixes land on the latest release.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- **Preferred:** [Report a vulnerability](https://github.com/vaulkerdoc/sereno/security/advisories/new)
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
  `/events`; `POST /hook`, `/status`). It is bound to loopback and is not
  authenticated — any process already running as your user can post events to it
  or read session state from it. That is the current threat model: Sereno assumes
  the local user is trusted. It never listens on an external interface.
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
