import { Keyboard } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import {
  normalizeChatSendShortcut,
  type ChatSendShortcut,
} from "../../lib/chat/sendShortcut";
import { useT } from "../../lib/i18n";

/**
 * Global keyboard shortcut for sending from the AI chat composer.
 * Default keeps the historical Ctrl+Enter behavior; Enter sends with Shift+Enter for newlines.
 */
export function ChatSendShortcutPanel() {
  const { config, saveConfig } = useAiStore();
  const t = useT();
  if (!config) return null;

  const OPTIONS = [
    {
      value: "ctrl_enter" as const,
      label: t("aiSettings.chatSendShortcutCtrlEnter"),
      desc: t("aiSettings.chatSendShortcutCtrlEnterDesc"),
    },
    {
      value: "enter" as const,
      label: t("aiSettings.chatSendShortcutEnter"),
      desc: t("aiSettings.chatSendShortcutEnterDesc"),
    },
  ] as const;

  const current = normalizeChatSendShortcut(config.chat_send_shortcut);

  const update = async (next: ChatSendShortcut) => {
    if (next === current) return;
    await saveConfig({ ...config, chat_send_shortcut: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Keyboard className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="text-[13px] font-semibold flex-1">{t("aiSettings.chatSendShortcutTitle")}</div>
      </div>
      <div className="text-[11px] text-[var(--taomni-text-muted)] -mt-1">
        {t("aiSettings.chatSendShortcutDesc")}
      </div>
      <div className="space-y-1 pt-1">
        {OPTIONS.map(({ value, label, desc }) => (
          <label key={value} className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="chat-send-shortcut"
              value={value}
              checked={current === value}
              onChange={() => void update(value)}
              className="mt-0.5 accent-[var(--taomni-accent)]"
            />
            <div>
              <div className="text-[12px]">{label}</div>
              <div className="text-[10px] text-[var(--taomni-text-muted)]">{desc}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
