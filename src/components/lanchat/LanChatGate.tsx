import { useEffect, useState } from "react";
import { Radio } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import { VaultGate } from "../vault/VaultGate";
import { LanChatPanel } from "./LanChatPanel";

/**
 * Access gate for the LanChat tab. Two sequential gates:
 *
 *  1. Master-password gate ([[VaultGate]]): opening the chat requires the
 *     app's master password to be unlocked (shared with the vault). A never-set
 *     vault is sent through setup first — LanChat requires a master password.
 *  2. Enable prompt: once unlocked, if the background service is not running
 *     (the opt-in default), the user is asked whether to start monitoring +
 *     broadcasting. Enabling is one-way (runs until app exit). Declining shows
 *     history read-only with an "开启聊天" button.
 *
 * Browser preview has no vault backend, so it renders the stubbed panel直接.
 */
export function LanChatGate() {
  const isDesktop = useLanChatStore((s) => s.isDesktop);
  const loadServiceState = useLanChatStore((s) => s.loadServiceState);

  useEffect(() => {
    void loadServiceState();
  }, [loadServiceState]);

  if (!isDesktop) return <LanChatPanel />;

  return (
    <VaultGate
      lockedTitle="局域网聊天已锁定"
      lockedHint="首次打开需要主密码解锁。该密码与应用的密码保险库共用。"
    >
      <ServiceGate />
    </VaultGate>
  );
}

/** Rendered only after the vault is unlocked. Handles the enable prompt. */
function ServiceGate() {
  const serviceRunning = useLanChatStore((s) => s.serviceRunning);
  const startOnLaunch = useLanChatStore((s) => s.startOnLaunch);
  const enableService = useLanChatStore((s) => s.enableService);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (serviceRunning || !startOnLaunch || asked) return;
    setAsked(true);
    void enableService();
  }, [asked, enableService, serviceRunning, startOnLaunch]);

  // Service already running (e.g. start-on-launch) → full panel, no prompt.
  if (serviceRunning) return <LanChatPanel />;

  // Not running and not yet answered → read-only history behind the prompt.
  if (!asked) {
    return (
      <>
        <LanChatPanel readOnly />
        <EnablePrompt
          onEnable={async () => {
            await enableService();
            setAsked(true);
          }}
          onSkip={() => setAsked(true)}
        />
      </>
    );
  }

  // Declined → history read-only with an inline "开启聊天" banner (in panel).
  return <LanChatPanel readOnly />;
}

function EnablePrompt({
  onEnable,
  onSkip,
}: {
  onEnable: () => void | Promise<void>;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      await onEnable();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center"
      style={{ background: "rgba(0,0,0,.35)" }}
      onClick={onSkip}
    >
      <div
        data-testid="lanchat-enable-prompt"
        className="w-[400px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-x-hidden overflow-y-auto rounded-xl"
        style={{
          background: "var(--taomni-panel-bg)",
          border: "1px solid var(--taomni-chrome-border)",
          boxShadow: "var(--taomni-shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-3 py-2.5"
          style={{ borderBottom: "1px solid var(--taomni-divider)" }}
        >
          <Radio className="h-4 w-4" style={{ color: "var(--taomni-accent)" }} />
          <span className="font-semibold">开启局域网聊天</span>
        </div>
        <div className="flex flex-col gap-2 p-4 text-[12px]" style={{ color: "var(--taomni-text)" }}>
          <p>开启后将在局域网内监听并广播本机,以便发现彼此并收发消息。</p>
          <p style={{ color: "var(--taomni-text-muted)" }}>
            本次运行开启后将持续监听 / 广播,关闭程序前无法停止。可在「隐私与安全」里设为随程序启动。
          </p>
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-[12px] disabled:opacity-50"
            style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}
          >
            暂不开启
          </button>
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(to bottom,var(--taomni-accent-soft),var(--taomni-accent))", border: "1px solid var(--taomni-accent)" }}
          >
            {busy ? "开启中…" : "开启聊天"}
          </button>
        </div>
      </div>
    </div>
  );
}
