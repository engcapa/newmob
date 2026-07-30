import { useState } from "react";
import { X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanPresence } from "../../types";
import { Avatar } from "./Avatar";

const STATUSES: { value: LanPresence; label: string }[] = [
  { value: "online", label: "在线" },
  { value: "away", label: "离开" },
  { value: "busy", label: "忙碌" },
];

/** Modal to edit this node's profile (display name / avatar / signature /
 *  status). Persists via the store, which re-announces over mDNS. */
export function ProfileEditor({ onClose }: { onClose: () => void }) {
  const profile = useLanChatStore((s) => s.profile);
  const saveProfile = useLanChatStore((s) => s.saveProfile);
  const isDesktop = useLanChatStore((s) => s.isDesktop);

  const [name, setName] = useState(profile?.name ?? "");
  const [signature, setSignature] = useState(profile?.signature ?? "");
  const [status, setStatus] = useState<LanPresence>(profile?.status ?? "online");
  const [avatarBase64, setAvatarBase64] = useState<string | null>(profile?.avatarBase64 ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickAvatar = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarBase64(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!name.trim()) {
      setError("显示名不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveProfile({
        name: name.trim(),
        avatarBase64: avatarBase64 ?? undefined,
        signature: signature.trim(),
        status,
      });
      onClose();
    } catch (e) {
      setError(isDesktop ? String(e) : "浏览器预览不支持保存资料（仅桌面版）");
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
        className="w-[360px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-x-hidden overflow-y-auto rounded-xl"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center px-3 py-2.5"
          style={{ borderBottom: "1px solid var(--taomni-divider)" }}
        >
          <span className="font-semibold">个人资料</span>
          <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded-md" onClick={onClose} style={{ color: "var(--taomni-text-muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <Avatar name={name || "我"} avatarBase64={avatarBase64} size={56} radius={14} status={status} />
            <label
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px]"
              style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}
            >
              更换头像
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPickAvatar(e.target.files?.[0])}
              />
            </label>
          </div>
          <Field label="显示名">
            <input value={name} onChange={(e) => setName(e.target.value)} className="lan-input" style={inputStyle} />
          </Field>
          <Field label="状态签名">
            <input value={signature} onChange={(e) => setSignature(e.target.value)} maxLength={60} className="lan-input" style={inputStyle} placeholder="一句话状态…" />
          </Field>
          <Field label="状态">
            <div className="flex gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  className="flex-1 rounded-lg py-1.5 text-[12px]"
                  style={{
                    border: "1px solid var(--taomni-input-border)",
                    background: status === s.value ? "var(--taomni-selected)" : "var(--taomni-card-bg)",
                    color: "var(--taomni-text)",
                    fontWeight: status === s.value ? 600 : 400,
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Field>
          {error ? <div className="text-[11px]" style={{ color: "var(--busy,#ef4444)" }}>{error}</div> : null}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-[12px]" style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}>
            取消
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
