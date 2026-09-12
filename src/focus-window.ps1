# Brings the terminal hosting a Claude Code session to the foreground.
#
# We only know the session's claude.exe pid (reported by bin/emit.js as its own
# parent). That process usually owns no window of its own - the window belongs to
# the terminal hosting it - so we walk up the process tree until we find one.
#
# $PID is an automatic PowerShell variable, hence the parameter name.
param([int]$TargetPid)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SerenoWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

$current = $TargetPid
for ($i = 0; $i -lt 8 -and $current -gt 0; $i++) {
  $proc = $null
  try { $proc = Get-Process -Id $current -ErrorAction Stop } catch { break }

  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $handle = $proc.MainWindowHandle
    if ([SerenoWin]::IsIconic($handle)) { [SerenoWin]::ShowWindow($handle, 9) | Out-Null }  # SW_RESTORE

    # AppActivate first: it works around the foreground-lock rules that make a
    # bare SetForegroundWindow fail when the call comes from a child process.
    $activated = $false
    try {
      (New-Object -ComObject WScript.Shell).AppActivate($proc.Id) | Out-Null
      $activated = $true
    } catch { }
    if (-not $activated) { [SerenoWin]::SetForegroundWindow($handle) | Out-Null }

    Write-Output "OK $($proc.ProcessName) $($proc.Id)"
    exit 0
  }

  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
  if ($null -eq $parent) { break }
  $current = $parent.ParentProcessId
}

Write-Output "NOWINDOW"
exit 1
