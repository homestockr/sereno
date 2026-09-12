; Sereno installer customisations.
;
; Uninstalling without disconnecting first would leave Claude Code invoking a
; shim that no longer exists, on every tool call, in every session on the
; machine. So the uninstaller disconnects before the files are removed.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Disconnecting Sereno from Claude Code..."
    ; Still present at this point in the uninstall; ignore failure (never wired).
    nsExec::ExecToLog '"$INSTDIR\Sereno.exe" --unwire'
    Pop $0
  ${endIf}
!macroend
