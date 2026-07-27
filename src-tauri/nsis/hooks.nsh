; NSIS installer hooks for Taomni (wired up via bundle.windows.nsis.installerHooks).
;
; SocksCap's privileged pieces are the reason these exist. The elevated
; sockscap-helper.exe keeps its own image file locked while it runs, and the
; WinDivert kernel driver keeps WinDivert64.sys locked until the driver is
; unloaded — which happens only after the last handle to it closes. If either is
; still held when the installer writes files, the install fails with a "cannot
; overwrite file" error.
;
; The installer runs elevated, so unlike the app itself it can actually stop
; both. Everything here is best-effort: a missing process or an already-stopped
; service is the normal case and must not fail the install.

!macro StopSocksCapRuntime
  DetailPrint "Stopping SocksCap helper and WinDivert driver (if running)..."

  ; The elevated helper. It exits on its own when Taomni quits cleanly; this
  ; covers a crashed or orphaned one.
  nsExec::Exec 'taskkill.exe /F /IM sockscap-helper.exe'
  Pop $0

  ; Bundled xray-core sidecars, for the same reason.
  nsExec::Exec 'taskkill.exe /F /IM xray.exe'
  Pop $0

  ; Unload the driver so WinDivert64.sys is releasable. The service name differs
  ; across WinDivert versions; try each, ignoring "not installed".
  nsExec::Exec 'sc.exe stop WinDivert'
  Pop $0
  nsExec::Exec 'sc.exe stop WinDivert1.4'
  Pop $0
  nsExec::Exec 'sc.exe stop WinDivert14'
  Pop $0

  ; Give the kernel a moment to finish tearing the driver down before any file
  ; is written; the unload is asynchronous.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopSocksCapRuntime
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopSocksCapRuntime
!macroend
