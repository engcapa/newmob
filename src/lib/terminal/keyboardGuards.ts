/**
 * Determines whether the event target or active element is an editable form control
 * (e.g. input, textarea, select, contenteditable) that should handle its own native text
 * editing and clipboard actions (Cmd+V, Ctrl+V, Cmd+C, Ctrl+C, etc.), rather than having
 * those shortcuts intercepted by a parent terminal session.
 *
 * Note: xterm's internal textarea (`.xterm-helper-textarea`) is excluded, as keystrokes
 * focused on the terminal itself belong to the terminal session / PTY.
 */
export function isEditableTarget(
  target: EventTarget | null,
  activeEl: Element | null = typeof document !== "undefined" ? document.activeElement : null,
): boolean {
  const check = (el: unknown): boolean => {
    if (!el || !(el instanceof Element)) return false;
    if (el.classList.contains("xterm-helper-textarea")) return false;
    if (el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
      return true;
    }
    return false;
  };
  return check(target) || check(activeEl);
}

/**
 * Checks whether keyboard focus is within the terminal container or on the ambient window/body,
 * as opposed to being explicitly focused within a separate panel (e.g. SFTP sidebar, file manager,
 * modal dialog, or external drawer).
 */
export function isTerminalFocused(
  panelEl: HTMLElement | null,
  activeEl: Element | null = typeof document !== "undefined" ? document.activeElement : null,
): boolean {
  if (!activeEl) return true;
  if (
    activeEl === document.body ||
    activeEl === document.documentElement ||
    activeEl.id === "root" ||
    activeEl.classList.contains("taomni-app")
  ) {
    return true;
  }
  return panelEl ? panelEl.contains(activeEl) : false;
}
