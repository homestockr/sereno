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

### Signing does not remove the warning on day one

This is the part that surprises people, so it is worth being blunt: **no signing
option makes the SmartScreen warning disappear immediately.** SmartScreen trusts
*reputation*, which accrues to a consistent publisher identity as downloads
accumulate. Signing is what lets reputation accumulate at all — an unsigned
binary starts from zero forever, because there is no identity to attach it to.

EV certificates used to bypass SmartScreen outright on first download. **Microsoft
removed that behaviour in 2024.** An EV certificate now behaves exactly like an OV
one for SmartScreen purposes, so paying the EV premium for that reason alone is no
longer justified.

### The options, as of September 2026

| Option | Cost | Hardware token | Notes |
|---|---|---|---|
| **SignPath Foundation** | free | no | OV-level signing for qualifying **open-source** projects |
| **Azure Artifact Signing** (was Trusted Signing) | ~$9.99/mo | no | Individuals: **USA/Canada only**. Orgs: +EU/UK |
| **OV certificate** (DigiCert, Sectigo…) | $150–300/yr | **yes** | Worldwide. HSM/USB token required since June 2023 |
| **EV certificate** | $400+/yr | yes | No SmartScreen advantage over OV any more |
| Self-signed | free | no | Dev/testing or managed enterprise only — blocks public users |

Sereno is a public repository, so **SignPath Foundation is worth applying to
first** — it is free and purpose-built for this case. Azure Artifact Signing is
the cheapest paid route and needs no USB token, which matters for automated
builds.

### Wiring it into the build

electron-builder 26 exposes two paths under `win`:

**Traditional certificate** (`signtoolOptions`, or just the env vars):

```sh
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=...
npm run dist
```

**Azure Artifact Signing** (`win.azureSignOptions` in `package.json`, credentials
from `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`):

```json
"win": {
  "azureSignOptions": {
    "endpoint": "https://eus.codesigning.azure.net",
    "codeSigningAccountName": "<account>",
    "certificateProfileName": "<profile>",
    "publisherName": "<validated name>"
  }
}
```

Whichever you pick, **sign every release with the same identity**. Switching
certificates or providers restarts reputation from zero. Worth knowing: a silent
CA rotation on the Azure service in March 2026 did exactly that to its customers,
and releases started warning again despite valid signatures — so budget for the
possibility rather than assuming signed means silent.

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
