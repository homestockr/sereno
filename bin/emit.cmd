@echo off
rem Sereno shim for packaged builds.
rem
rem Claude Code ships as a native binary and needs no Node, so a distributed
rem Sereno must not assume Node either. Electron runs as a plain Node runtime
rem under ELECTRON_RUN_AS_NODE, and this wrapper keeps the hook a single string.
rem
rem Nothing may be echoed here: in statusline mode stdout IS the statusline.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Sereno.exe" "%~dp0app.asar.unpacked\bin\emit.js" %*
