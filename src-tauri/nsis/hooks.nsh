; NSIS installer hooks for Taomni (wired up via bundle.windows.nsis.installerHooks).
;
; SocksCap's privileged pieces are the reason these exist. The elevated
; sockscap-helper.exe keeps its own image file locked while it runs, and the
; WinDivert kernel driver keeps WinDivert64.sys locked until the driver is
; unloaded — which happens only after the last handle to it closes. If either is
; still held when the installer writes files, the install fails with a "cannot
; overwrite file" error.
;
; IMPORTANT: this hook is only a BACKSTOP, not the primary release path. Taomni
; ships as a per-user (currentUser) install, so the installer runs UNELEVATED.
; Against the UAC-elevated helper and the WinDivert kernel service, this hook's
; taskkill/sc-stop get Access Denied and do nothing. The real teardown happens
; app-side, before the updater launches this installer: the app asks its own
; elevated helper (over the control channel it owns) to close the driver handles
; and exit — see `sockscap_prepare_for_update` in src/sockscap/mod.rs.
;
; What this hook still buys us:
;   - per-machine installs (should they ever ship), where the installer IS
;     elevated and these commands succeed;
;   - xray.exe, which runs at the app's own integrity level and so can be killed
;     from an unelevated installer;
;   - a crashed/orphaned helper the app-side path never got to stop.
; Everything here is best-effort: a missing process, an already-stopped service,
; or an Access-Denied is the normal case and must not fail the install.

!macro StopSocksCapRuntime
  DetailPrint "Stopping SocksCap helper and WinDivert driver (if running)..."

  ; The elevated helper. Normally already stopped app-side before we get here;
  ; this only lands for a crashed/orphaned one, and only if we are elevated.
  nsExec::Exec 'taskkill.exe /F /IM sockscap-helper.exe'
  Pop $0

  ; Bundled xray-core sidecars. These run at our own integrity level, so this
  ; succeeds even on an unelevated per-user install.
  nsExec::Exec 'taskkill.exe /F /IM xray.exe'
  Pop $0

  ; Unload the driver so WinDivert64.sys is releasable (elevated installs only).
  ; The service name differs across WinDivert versions; try each, ignoring
  ; "not installed" / "access denied".
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
