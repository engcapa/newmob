export type EditorBannerSeverity = "info" | "warning" | "error";

export type EditorBannerCategory =
  | "read-only"
  | "encoding-mismatch"
  | "sdk-import"
  | "indexing-degraded"
  | "custom";

export interface EditorBannerAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  primary?: boolean;
  danger?: boolean;
}

export interface EditorBannerItem {
  id: string;
  fileKey?: string; // If specified, only shown for that file; if undefined, global to editor
  category: EditorBannerCategory;
  severity: EditorBannerSeverity;
  title: string;
  description?: string;
  priority: number; // Higher number = higher priority (e.g. read-only=100, degraded=50)
  dismissible?: boolean;
  actions?: EditorBannerAction[];
  createdAt: number;
}

/**
 * Filters and prioritizes active banners for the current active file.
 */
export function selectActiveBanners(
  banners: readonly EditorBannerItem[],
  activeFileKey: string | null | undefined,
  dismissedIds: ReadonlySet<string>,
): EditorBannerItem[] {
  return banners
    .filter((b) => !dismissedIds.has(b.id))
    .filter((b) => !b.fileKey || b.fileKey === activeFileKey)
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}
