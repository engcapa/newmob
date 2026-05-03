import { useMemo, useState, useEffect } from "react";
import { ChevronRight, Home, HardDrive } from "lucide-react";

interface PathBreadcrumbProps {
  path: string;
  homePath?: string | null;
  onNavigate: (path: string) => void;
  onSubmit?: (path: string) => void;
  detectWindows?: boolean;
  testId?: string;
}

export function PathBreadcrumb({
  path,
  homePath,
  onNavigate,
  onSubmit,
  detectWindows,
  testId,
}: PathBreadcrumbProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);

  useEffect(() => {
    if (!editing) setEditValue(path);
  }, [path, editing]);

  const isDrivesRoot = path === "\\\\";
  const isWindows = detectWindows ?? (path.includes("\\") || isDrivesRoot);
  const sep = isWindows ? "\\" : "/";

  const segments = useMemo(() => {
    if (!path) return [];
    if (path === "/") return [{ label: "/", path: "/" }];
    if (isDrivesRoot) return [{ label: "Drives", path: "\\\\" }];
    if (isWindows) {
      const drive = path.match(/^([A-Z]):/i)?.[1];
      const rest = path.slice(drive ? 2 : 0).replace(/\\$/, "");
      const parts = rest.split("\\").filter(Boolean);
      const result: { label: string; path: string }[] = [];
      if (drive) result.push({ label: `${drive.toUpperCase()}:`, path: `${drive.toUpperCase()}:\\` });
      let acc = drive ? `${drive.toUpperCase()}:` : "";
      for (const part of parts) {
        acc = acc ? `${acc}\\${part}` : part;
        result.push({ label: part, path: acc });
      }
      return result;
    }
    const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
    const result: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc = `${acc}/${part}`;
      result.push({ label: part, path: acc });
    }
    return result;
  }, [path, isWindows]);

  const handleEnter = () => {
    setEditing(false);
    if (editValue && editValue !== path) {
      onSubmit?.(editValue);
    }
  };

  if (editing) {
    return (
      <input
        data-testid={testId}
        aria-label={testId}
        autoFocus
        className="moba-input flex-1 h-6"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleEnter}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleEnter();
          else if (e.key === "Escape") {
            setEditValue(path);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div
      data-testid={testId}
      className="flex-1 h-6 flex items-center gap-0.5 px-1.5 overflow-x-auto text-[12px] cursor-text"
      style={{ background: "var(--moba-input-bg)", border: "1px solid var(--moba-input-border)", borderRadius: 2 }}
      onClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        navigator.clipboard?.writeText(path).catch(() => {});
      }}
      title="Click to edit • right-click to copy"
    >
      {homePath && homePath !== path && (
        <button
          type="button"
          className="px-1 hover:bg-[var(--moba-hover)] rounded shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(homePath);
          }}
          title="Go to home"
        >
          <Home className="w-3 h-3" />
        </button>
      )}
      {isWindows && !isDrivesRoot && (
        <button
          type="button"
          data-testid="breadcrumb-drives-root"
          className="px-1 hover:bg-[var(--moba-hover)] rounded shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate("\\\\");
          }}
          title="Show all drives"
        >
          <HardDrive className="w-3 h-3" />
        </button>
      )}
      {segments.map((seg, i) => (
        <span key={`${seg.path}-${i}`} className="flex items-center shrink-0">
          {i > 0 && <ChevronRight className="w-3 h-3 opacity-50" />}
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(seg.path);
            }}
          >
            {seg.label || sep}
          </button>
        </span>
      ))}
    </div>
  );
}
