import { useState } from "react";
import { X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import { Avatar } from "./Avatar";

/** Modal to create a group/channel: pick a name + members from the roster. */
export function GroupCreateDialog({ onClose }: { onClose: () => void }) {
  const roster = useLanChatStore((s) => s.roster);
  const createGroup = useLanChatStore((s) => s.createGroup);
  const setSegment = useLanChatStore((s) => s.setSegment);
  const openConversation = useLanChatStore((s) => s.openConversation);

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!name.trim()) {
      setError("群组名称不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    const group = await createGroup(name.trim(), Array.from(selected));
    setBusy(false);
    if (group) {
      setSegment("groups");
      void openConversation(`group:${group.id}`);
      onClose();
    } else {
      setError("创建失败（浏览器预览不支持，仅桌面版）");
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center" style={{ background: "rgba(0,0,0,.35)" }} onClick={onClose}>
      <div
        className="flex max-h-[calc(100vh-24px)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-3 py-2.5" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <span className="font-semibold">新建群组 / 频道</span>
          <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded-md" onClick={onClose} style={{ color: "var(--taomni-text-muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="群组名称，如 研发大群"
            style={{ width: "100%", height: 30, borderRadius: 6, padding: "0 9px", outline: "none", border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)", color: "var(--taomni-text)" }}
          />
          <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            选择成员（{selected.size}）
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {roster.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              暂无可邀请的在线成员
            </div>
          ) : (
            roster.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                className="mb-px flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
                style={{ background: selected.has(p.id) ? "var(--taomni-selected)" : "transparent" }}
              >
                <Avatar name={p.name} colorKey={p.id} status={p.status} size={28} />
                <span className="flex-1 truncate">{p.name}</span>
                <input type="checkbox" readOnly checked={selected.has(p.id)} />
              </button>
            ))
          )}
        </div>
        {error ? <div className="px-4 text-[11px]" style={{ color: "var(--busy,#ef4444)" }}>{error}</div> : null}
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--taomni-divider)" }}>
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-[12px]" style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}>
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(to bottom,var(--taomni-accent-soft),var(--taomni-accent))", border: "1px solid var(--taomni-accent)" }}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
