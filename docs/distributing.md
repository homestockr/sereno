# Building and distributing Sereno

```sh
npm run dist          # installer + zip, into dist/
npm run dist:dir      # unpacked folder only, much faster while iterating
npm run test:packaged # verifies the built shim actually works
```

Artifacts land in `dist/`:

| file | what it is | size |
|---|---|---|
| `Sereno Setup 1.0.0.exe` | NSIS installer, per-user, no admin needed | ~90 MB |
| `Sereno-1.0.0-win.zip` | unpacked folder, no install | ~126 MB |
| `win-unpacked/` | what the zip contains |  |

They are large because each carries a full Electron runtime. That is the price of
the next section.

---

## The constraint that shaped the build

**The shim runs on every tool call, and a distributed copy cannot assume Node.**

Claude Code ships as a single native `claude.exe` and needs no Node runtime, so a
machine running it very plausibly has no `node` on `PATH`. But `bin/emit.js` is
invoked by every hook and by the statusline. Writing `node "…/emit.js"` into a
stranger's `settings.json` would break their Claude Code the moment they had no
Node — on every tool call, in every session.

Electron *is* a Node runtime. With `ELECTRON_RUN_AS_NODE=1` it skips Chromium
entirely and behaves like `node`. `bin/emit.cmd` wraps that so a hook stays a
single command string:

```bat
@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Sereno.exe" "%~dp0app.asar.unpacked\bin\emit.js" %*
```

Measured cost of going through Electron instead of Node: **171 ms** per invocation
with the collector down, versus ~436 ms for `node` on the same machine. It is not
a regression — it is faster, because the Electron binary is already warm.

`@echo off` is load-bearing. In statusline mode stdout *is* the statusline, so a
single stray echoed line would corrupt it.

### Two things that must stay outside app.asar

`asar` is a virtual archive that only Electron's patched `fs` can read. Any
**external** process reading a packaged file needs it unpacked:

- `bin/emit.js` — run by Electron-as-Node, spawned fresh by the shell
- `src/focus-window.ps1` — read by `powershell.exe`, which knows nothing of asar

Both are in `asarUnpack`. `main.js` rewrites `__dirname` to the unpacked tree when
handing the script path to PowerShell.

### Why there is no single-file "portable" target

electron-builder's `portable` target extracts to a **fresh temp directory on every
launch**. Sereno writes absolute shim paths into `settings.json`, so those paths
would be dead the next time it started — and Claude Code would keep calling them.
The `zip` target is the portable option instead: a folder the user puts somewhere
permanent, with a stable path.

---

## Uninstalling cleanly

Removing the app without unwiring would leave every Claude Code session invoking a
shim that no longer exists. So the uninstaller disconnects first
(`build/installer.nsh`):

```nsis
nsExec::ExecToLog '"$INSTDIR\Sereno.exe" --unwire'
```

`--unwire` is handled in `main.js` before any window is created. It calls
`wiring.removeEntries()`, which deletes **only** Sereno's own `statusLine` and hook
entries and leaves everything else in the file untouched — deliberately not a
backup restore, which would also roll back unrelated settings changed since, and
would do nothing at all if the newest backup predated a second wiring.

Zip users should disconnect from inside the app before deleting the folder.

---

## Code signing — read this before publishing

**The build is unsigned.** `Get-AuthenticodeSignature` reports `NotSigned` for both
`Sereno.exe` and the installer. For anyone who downloads it that means:

- SmartScreen shows *"Windows protected your PC"* with a **Don't run** default.
  Getting past it takes *More info → Run anyway*.
- Some corporate policies block unsigned executables outright.
- Browsers may warn on download.

To sign, get an Authenticode certificate — an **EV or OV certificate from a CA**;
a self-signed one does not help, because SmartScreen trusts reputation, not
signatures alone. Then:

```sh
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=...
npm run dist
```

electron-builder picks those up automatically. Even signed, a new certificate has
no SmartScreen reputation and warns until it accumulates downloads; an EV
certificate gets reputation immediately.

If you are only sharing this with a few people, unsigned is fine — tell them to
expect the warning, which is far better than them hitting it unprepared.

---

## Releasing

Bump `version` in `package.json`; it names the artifacts. There is **no
auto-updater** configured — users replace the install manually. Adding one means
`electron-updater` plus somewhere to host a feed, and signing, since unsigned
updates are a genuine attack vector.

Do not commit `dist/`. It is gitignored.

## A note on what you are shipping

Sereno writes to a file that governs every Claude Code session on the user's
machine. That is a lot of trust for a widget. The install path is built to earn it:
it backs up before writing, merges rather than overwrites, asks before displacing
an existing statusline, is idempotent, removes exactly its own entries on
uninstall, and the shim exits 0 on every failure path so a broken Sereno can never
take Claude Code down with it. Keep that property if you change this code — it is
the difference between a widget and a liability.
