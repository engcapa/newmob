/** Values persisted on `AiConfig.chat_send_shortcut`. */
export type ChatSendShortcut = "enter" | "ctrl_enter";

export const DEFAULT_CHAT_SEND_SHORTCUT: ChatSendShortcut = "ctrl_enter";

export function normalizeChatSendShortcut(value?: string | null): ChatSendShortcut {
  return value === "enter" ? "enter" : DEFAULT_CHAT_SEND_SHORTCUT;
}

/** True when the key event should submit the chat composer for the given shortcut mode. */
export function isChatSendKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
  shortcut: ChatSendShortcut,
): boolean {
  if (event.key !== "Enter") return false;
  // IME composition: Enter confirms candidate text, must not send.
  if (event.isComposing || event.keyCode === 229) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (shortcut === "ctrl_enter") {
    return mod;
  }
  // enter mode: plain Enter sends; Shift+Enter newline; Ctrl/Cmd+Enter also sends.
  return mod || !event.shiftKey;
}
