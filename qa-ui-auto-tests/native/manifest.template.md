# Native gate manifest — §8.19.10 rollup

> Sanitized rollup only; raw runs live under `qa-ui-auto-report/evidence/`.
> Copy this file per release candidate and fill one row per matrix cell.
> `platform-unverified` / `provider-unverified` cells stay until a real run
> replaces them — they are never inferred from another platform.

## G0 save/disk matrix

| Item | Linux | Windows | macOS |
|---|---|---|---|
| locked / permission / hash conflict | platform-unverified | platform-unverified | platform-unverified |
| atomic replace fault points (Rust fault harness) | platform-unverified | platform-unverified | platform-unverified |
| external watcher | platform-unverified | platform-unverified | platform-unverified |
| encoding / EOL / BOM | platform-unverified | platform-unverified | platform-unverified |
| save close/unmount | platform-unverified | platform-unverified | platform-unverified |
| WorkspaceEdit partial/resume/undo | platform-unverified | platform-unverified | platform-unverified |
| symlink/case/UNC (platform-relevant only) | n/a-recorded | recorded | recorded |

## G1 keymap/focus/a11y matrix

| Item | Linux | Windows | macOS |
|---|---|---|---|
| Keymap chord (non-US layout) | platform-unverified | platform-unverified | platform-unverified |
| AltGr | platform-unverified | platform-unverified | platform-unverified |
| dead key | platform-unverified | platform-unverified | platform-unverified |
| IME composition | platform-unverified | platform-unverified | platform-unverified |
| system clipboard denied | platform-unverified | platform-unverified | platform-unverified |
| Switcher modifier release | platform-unverified | platform-unverified | platform-unverified |
| tab restore | platform-unverified | platform-unverified | platform-unverified |
| QuickDoc/Parameter focus | platform-unverified | platform-unverified | platform-unverified |
| screen reader basic path (manual smoke) | platform-unverified | platform-unverified | platform-unverified |

## Performance budget (baseline → regression gate)

| Metric | Target p95 | Baseline (browser) | Baseline (native linux) | native win | native mac |
|---|---|---|---|---|---|
| normal input key-to-paint | 50 ms | not recorded | platform-unverified | platform-unverified | platform-unverified |
| local action/Switcher | 100 ms | not recorded | platform-unverified | platform-unverified | platform-unverified |
| completion debounce/IPC/provider/paint + cancel rate | record + gate | not recorded | platform-unverified | platform-unverified | platform-unverified |
| 1 MiB file CPU/mem/long-task | record | not recorded | platform-unverified | platform-unverified | platform-unverified |
| 10k candidates | record | not recorded | platform-unverified | platform-unverified | platform-unverified |
| 10k-file workspace | record | not recorded | platform-unverified | platform-unverified | platform-unverified |
| 3+ splits | record | not recorded | platform-unverified | platform-unverified | platform-unverified |

## Provider evidence (R3/R6/R7)

| Item | Status |
|---|---|
| pinned JDK/jdtls/Maven/Gradle real process trace | provider-unverified |
| JSON-RPC method/timing/id/cancel/result summary (sanitized) | provider-unverified |
| provider crash/restart recovery | provider-unverified |
| classpath broken recovery | provider-unverified |
| network offline recovery | provider-unverified |

## a11y

| Item | Automated scan | Manual keyboard/screen-reader smoke |
|---|---|---|
| dialog/menu/listbox/tab role+name+state | not run | per-platform manual, never automated |
| focus trap/return/cancellation | not run | manual |
| announcements: completion/conflict/save-recovery/unavailable | not run | manual |
| high contrast / 200% zoom / narrow viewport / reduced motion | not run | manual |

## Sign-off

G0 may be marked green and G1 release-ready **only** when: R2 catalog/browser
all green; G0 native matrix has no unexplained data-effect; G1 three platforms
have no shortcut/IME/focus blocker; performance/a11y manifest complete;
R3/R6 real provider evidence exists. Until then every gap above stays as-is.
