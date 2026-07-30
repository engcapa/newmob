import { useEffect, useMemo, useState } from "react";
import type { FileEntry } from "../../lib/sftp";
import { useT, type TranslateFn } from "../../lib/i18n";

type Who = "owner" | "group" | "other";
type Bit = "read" | "write" | "execute";

const WHO_ORDER: Who[] = ["owner", "group", "other"];
const BIT_ORDER: Bit[] = ["read", "write", "execute"];

function whoLabel(t: TranslateFn, who: Who): string {
  switch (who) {
    case "owner": return t("fileBrowser.chmodOwnerLabel");
    case "group": return t("fileBrowser.chmodGroupLabel");
    case "other": return t("fileBrowser.chmodOtherLabel");
  }
}

function bitLabel(t: TranslateFn, bit: Bit): string {
  switch (bit) {
    case "read": return t("fileBrowser.chmodReadLabel");
    case "write": return t("fileBrowser.chmodWriteLabel");
    case "execute": return t("fileBrowser.chmodExecuteLabel");
  }
}

const BIT_CHAR: Record<Bit, string> = {
  read: "r",
  write: "w",
  execute: "x",
};

function bitMask(who: Who, bit: Bit): number {
  const whoShift = who === "owner" ? 6 : who === "group" ? 3 : 0;
  const bitVal = bit === "read" ? 4 : bit === "write" ? 2 : 1;
  return bitVal << whoShift;
}

function modeToOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function modeToSymbolic(mode: number): string {
  let s = "";
  for (const w of WHO_ORDER) {
    for (const b of BIT_ORDER) {
      s += (mode & bitMask(w, b)) !== 0 ? BIT_CHAR[b] : "-";
    }
  }
  return s;
}

function parseOctalInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null;
  const value = parseInt(trimmed, 8);
  if (!Number.isFinite(value)) return null;
  return value & 0o777;
}

export interface ChmodDialogProps {
  entries: FileEntry[];
  onCancel: () => void;
  onApply: (mode: number, recursive: boolean) => void;
}

export function ChmodDialog({ entries, onCancel, onApply }: ChmodDialogProps) {
  const t = useT();
  const initialMode = useMemo(() => {
    if (entries.length === 0) return 0o644;
    const first = entries[0].mode;
    const allSame = entries.every((e) => (e.mode & 0o777) === (first & 0o777));
    if (allSame && first != null) return first & 0o777;
    // Mixed: start from the first entry's mode (best effort).
    return (first ?? 0o644) & 0o777;
  }, [entries]);

  const [mode, setMode] = useState<number>(initialMode);
  const [octalText, setOctalText] = useState<string>(modeToOctal(initialMode));
  const [recursive, setRecursive] = useState<boolean>(false);

  useEffect(() => {
    setOctalText(modeToOctal(mode));
  }, [mode]);

  const hasDir = entries.some((e) => e.fileType === "dir");
  const summary =
    entries.length === 1
      ? entries[0].name
      : t("fileBrowser.chmodEntriesLabel", { count: entries.length });

  const toggleBit = (who: Who, bit: Bit) => {
    setMode((m) => m ^ bitMask(who, bit));
  };

  const handleOctalChange = (text: string) => {
    setOctalText(text);
    const parsed = parseOctalInput(text);
    if (parsed != null) setMode(parsed);
  };

  const octalValid = parseOctalInput(octalText) != null;

  const handleApply = () => {
    if (!octalValid) return;
    onApply(mode & 0o777, recursive && hasDir);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") handleApply();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={t("fileBrowser.chmodHeading")}
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{t("fileBrowser.chmodHeading")}</div>
        <div
          className="text-[12px] mb-3 break-all"
          style={{ color: "var(--taomni-text-muted)" }}
          title={summary}
        >
          {summary}
        </div>

        <table className="w-full text-[12px] mb-3 border-collapse">
          <thead>
            <tr style={{ color: "var(--taomni-text-muted)" }}>
              <th className="text-left font-normal pb-1"></th>
              {BIT_ORDER.map((b) => (
                <th key={b} className="font-normal pb-1 text-center">
                  {bitLabel(t, b)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WHO_ORDER.map((w) => (
              <tr key={w}>
                <td className="py-0.5 pr-2">{whoLabel(t, w)}</td>
                {BIT_ORDER.map((b) => {
                  const checked = (mode & bitMask(w, b)) !== 0;
                  const id = `chmod-${w}-${b}`;
                  return (
                    <td key={b} className="text-center py-0.5">
                      <input
                        id={id}
                        type="checkbox"
                        aria-label={t("fileBrowser.chmodAriaCheckbox", { who: whoLabel(t, w), bit: bitLabel(t, b) })}
                        checked={checked}
                        onChange={() => toggleBit(w, b)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex items-center gap-2 mb-2 text-[12px]">
          <label htmlFor="chmod-octal" className="shrink-0" style={{ color: "var(--taomni-text-muted)" }}>
            {t("fileBrowser.chmodOctalLabel")}
          </label>
          <input
            id="chmod-octal"
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={octalText}
            onChange={(e) => handleOctalChange(e.target.value)}
            className="w-16 px-1.5 py-0.5 font-mono text-[12px] rounded"
            style={{
              background: "var(--taomni-input-bg)",
              border: `1px solid ${octalValid ? "var(--taomni-input-border)" : "#c0392b"}`,
              color: "var(--taomni-text)",
            }}
            aria-invalid={!octalValid}
          />
          <span className="font-mono" style={{ color: "var(--taomni-text-muted)" }}>
            {modeToSymbolic(mode)}
          </span>
        </div>

        {hasDir && (
          <label className="flex items-center gap-2 mb-3 text-[12px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            <span>{t("fileBrowser.chmodApplyRecursive")}</span>
          </label>
        )}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {t("fileBrowser.chmodCancel")}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={handleApply}
            disabled={!octalValid}
          >
            {t("fileBrowser.chmodApply")}
          </button>
        </div>
      </div>
    </div>
  );
}

export const __testing = { modeToOctal, modeToSymbolic, bitMask, parseOctalInput };
