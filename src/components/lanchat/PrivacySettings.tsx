import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanRetention } from "../../types";

const DEFAULT_RETENTION: LanRetention = {
  retentionDays: 90,
  maxPerConv: 5000,
  cleanupEnabled: true,
};

/** Modal for message-retention policy, history clearing, and this node's
 *  identity fingerprint. */
export function PrivacySettings({ onClose }: { onClose: () => void }) {
  const profile = useLanChatStore((s) => s.profile);
  const retention = useLanChatStore((s) => s.retention);
  const loadRetention = useLanChatStore((s) => s.loadRetention);
  const saveRetention = useLanChatStore((s) => s.saveRetention);
  const clearAllHistory = useLanChatStore((s) => s.clearAllHistory);
  const isDesktop = useLanChatStore((s) => s.isDesktop);
  const serviceRunning = useLanChatStore((s) => s.serviceRunning);
  const startOnLaunch = useLanChatStore((s) => s.startOnLaunch);
  const setStartOnLaunch = useLanChatStore((s) => s.setStartOnLaunch);
  const loadServiceState = useLanChatStore((s) => s.loadServiceState);

  const [form, setForm] = useState<LanRetention>(retention ?? DEFAULT_RETENTION);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void loadRetention();
    void loadServiceState();
  }, [loadRetention, loadServiceState]);
  useEffect(() => {
    if (retention) setForm(retention);
  }, [retention]);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await saveRetention({
        retentionDays: Math.max(0, Math.floor(form.retentionDays)),
        maxPerConv: Math.max(0, Math.floor(form.maxPerConv)),
        cleanupEnabled: form.cleanupEnabled,
      });
      setNote("已保存");
    } catch (e) {
      setNote(isDesktop ? String(e) : "浏览器预览不支持保存（仅桌面版）");
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("确定清空本机全部聊天记录？此操作不可撤销。")) return;
    setBusy(true);
    try {
      await clearAllHistory();
      setNote("已清空全部聊天记录");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center"
      style={{ background: "rgba(0,0,0,.35)" }}
      onClick={onClose}
    >
      <div
        className="w-[400px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-x-hidden overflow-y-auto rounded-xl"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <ShieldCheck className="h-4 w-4" style={{ color: "var(--taomni-accent)" }} />
          <span className="font-semibold">隐私与安全</span>
          <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded-md" onClick={onClose} style={{ color: "var(--taomni-text-muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div
            className="flex flex-col gap-2 rounded-lg p-3"
            style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-divider)" }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium">局域网监听 / 广播</span>
              <span
                className="text-[11px] font-medium"
                style={{ color: serviceRunning ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
              >
                {serviceRunning ? "● 运行中" : "○ 未开启"}
              </span>
            </div>
            <label className="flex items-center justify-between">
              <span className="text-[12px]">随程序启动时开启</span>
              <input
                type="checkbox"
                checked={startOnLaunch}
                onChange={(e) => void setStartOnLaunch(e.target.checked)}
              />
            </label>
            <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              开启后本次运行将持续监听并广播,关闭程序前无法停止。
            </div>
          </div>
          <label className="flex items-center justify-between">
            <span className="text-[12px]">自动清理历史消息</span>
            <input
              type="checkbox"
              checked={form.cleanupEnabled}
              onChange={(e) => setForm((f) => ({ ...f, cleanupEnabled: e.target.checked }))}
            />
          </label>
          <Field label="保留天数（0 = 不限）">
            <input
              type="number"
              min={0}
              value={form.retentionDays}
              onChange={(e) => setForm((f) => ({ ...f, retentionDays: Number(e.target.value) }))}
              className="lan-input"
              style={inputStyle}
            />
          </Field>
          <Field label="每会话最多保留条数（0 = 不限）">
            <input
              type="number"
              min={0}
              value={form.maxPerConv}
              onChange={(e) => setForm((f) => ({ ...f, maxPerConv: Number(e.target.value) }))}
              className="lan-input"
              style={inputStyle}
            />
          </Field>
          <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            消息正文在本机以 AES-256 加密存储。本机身份指纹：
            <code className="break-all" style={{ color: "var(--taomni-text)" }}>
              {profile?.id ? `${profile.id.slice(0, 16)}…` : "—"}
            </code>
          </div>
          <button
            type="button"
            onClick={() => void clearAll()}
            disabled={busy}
            className="rounded-lg py-1.5 text-[12px] disabled:opacity-50"
            style={{ border: "1px solid var(--busy,#ef4444)", color: "var(--busy,#ef4444)", background: "transparent" }}
          >
            清空全部聊天记录
          </button>
          {note ? <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{note}</div> : null}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-[12px]" style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}>
            关闭
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(to bottom,var(--taomni-accent-soft),var(--taomni-accent))", border: "1px solid var(--taomni-accent)" }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  borderRadius: 6,
  padding: "0 9px",
  outline: "none",
  border: "1px solid var(--taomni-input-border)",
  background: "var(--taomni-input-bg)",
  color: "var(--taomni-text)",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}
