# Brings the terminal hosting a Claude Code session to the foreground.
#
# We only know the session's claude.exe pid (reported by bin/emit.js as its own
# parent). That process usually owns no window of its own - the window belongs to
# the terminal hosting it - so we walk up the process tree until we find one.
#
# THE HARD PART IS PICKING THE RIGHT WINDOW. Windows Terminal hosts every window
# it has ever opened inside a SINGLE process, so `.MainWindowHandle` returns one
# arbitrary handle no matter which session asked. With three sessions open in
# three terminal windows, every "Review in terminal" raised the same one.
#
# So we enumerate the terminal's windows ourselves and pick by title. The title
# of a session's console is the one thing that reliably distinguishes it, and it
# can be read without touching the transcript: attach to the target's console,
# ask for the title, detach. The leading glyph is a spinner and changes between
# reads, so matching ignores everything before the first word character.
#
# $PID is an automatic PowerShell variable, hence the parameter name.
param(
  [int]$TargetPid,
  # Resolve and report the window without activating it. Used by the tests.
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SerenoWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);

  // Visible top-level windows owned by a process, as "handle`ttitle" lines.
  // Untitled windows are skipped: a terminal keeps invisible helper windows that
  // would otherwise be indistinguishable from the real one.
  public static List<string> WindowsOf(uint want) {
    var found = new List<string>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) {
        int len = GetWindowTextLength(h);
        if (len > 0) {
          var sb = new StringBuilder(len + 1);
          GetWindowText(h, sb, sb.Capacity);
          if (sb.Length > 0) found.Add(h.ToInt64() + "\t" + sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitleW(StringBuilder s, uint n);

  // The title of another process's console.
  //
  // A process may only be attached to one console, so a caller that already has
  // one has to let it go first. That is why this is never called unless there is
  // an actual ambiguity to resolve: when the terminal owns a single window there
  // is nothing to disambiguate and nothing to risk.
  public static string ConsoleTitleOf(uint pid) {
    bool attached = AttachConsole(pid);
    if (!attached) {
      FreeConsole();                 // we had one of our own; try again without it
      attached = AttachConsole(pid);
    }
    if (!attached) return null;
    try {
      var sb = new StringBuilder(1024);
      uint n = GetConsoleTitleW(sb, 1024);
      return n > 0 ? sb.ToString() : null;
    } finally {
      FreeConsole();
    }
  }
}
"@

# Titles carry a leading spinner glyph that differs between two reads of the same
# window, so comparison starts at the first word character and ignores case.
function Normalize([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return '' }
  $t = $s -replace '^[^\p{L}\p{N}]+', ''
  return $t.Trim().ToLowerInvariant()
}

function Activate([IntPtr]$handle, [int]$ownerPid, [string]$how, [string]$title) {
  if ($WhatIf) {
    Write-Output "OK $how $($handle.ToInt64()) $title"
    exit 0
  }
  if ([SerenoWin]::IsIconic($handle)) { [SerenoWin]::ShowWindow($handle, 9) | Out-Null }  # SW_RESTORE

  # AppActivate first: it works around the foreground-lock rules that make a
  # bare SetForegroundWindow fail when the call comes from a child process. It
  # can only address a process, so where a process owns several windows the
  # explicit handle is the one that actually disambiguates.
  $activated = $false
  try {
    (New-Object -ComObject WScript.Shell).AppActivate($ownerPid) | Out-Null
    $activated = $true
  } catch { }
  [SerenoWin]::SetForegroundWindow($handle) | Out-Null

  Write-Output "OK $how $($handle.ToInt64()) $title"
  exit 0
}

# Walk up until we reach a process that actually owns visible windows. The shell
# between claude.exe and the terminal owns none, so this usually lands on the
# terminal itself.
$current = $TargetPid
for ($i = 0; $i -lt 8 -and $current -gt 0; $i++) {
  $proc = $null
  try { $proc = Get-Process -Id $current -ErrorAction Stop } catch { break }

  $windows = [SerenoWin]::WindowsOf([uint32]$proc.Id)

  if ($windows.Count -eq 1) {
    # No ambiguity, so no need to touch the target's console at all.
    $parts = $windows[0].Split("`t", 2)
    Activate ([IntPtr][int64]$parts[0]) $proc.Id 'single' $parts[1]
  }

  if ($windows.Count -gt 1) {
    $want = Normalize ([SerenoWin]::ConsoleTitleOf([uint32]$TargetPid))
    if ($want -ne '') {
      foreach ($w in $windows) {
        $parts = $w.Split("`t", 2)
        if ((Normalize $parts[1]) -eq $want) {
          Activate ([IntPtr][int64]$parts[0]) $proc.Id 'matched' $parts[1]
        }
      }
    }
    # Nothing matched - the title may have changed under us, or this terminal
    # does not set one. Raising the wrong window still beats raising none, but
    # say which path we took so the failure is legible.
    $parts = $windows[0].Split("`t", 2)
    Activate ([IntPtr][int64]$parts[0]) $proc.Id 'unmatched' $parts[1]
  }

  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
  if ($null -eq $parent) { break }
  $current = $parent.ParentProcessId
}

Write-Output "NOWINDOW"
exit 1
