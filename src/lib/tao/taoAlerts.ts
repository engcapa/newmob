import type { NoteAlert } from "../notes";

/**
 * Unified Tao alert model (see tao-notes-feature-plan.md). A single
 * badge/jump mechanism serves notes due/overdue/reminder alerts and chat
 * "AI reply ready" events today, with `mail` reserved for a future module.
 */
export type TaoAlertSource = "chat" | "notes" | "mail";
export type TaoAlertKind =
  | "ai_done"
  | "note_overdue"
  | "note_due_soon"
  | "note_reminder"
  | "mail_new";

export interface TaoAlert {
  id: string;
  source: TaoAlertSource;
  kind: TaoAlertKind;
  title: string;
  /** Aggregated item count for sources that collapse many events into one alert. */
  count?: number;
  /** Chat target (source === "chat"). */
  threadId?: string | null;
  /** Notes target (source === "notes"). */
  noteId?: string | null;
  /** Mail tab target (source === "mail"). */
  mailTabId?: string | null;
  /** Mail account/session id (source === "mail"). */
  mailAccountId?: string | null;
  fireAt: number;
}

/** Ribbon summary state (§7.2). */
export type RibbonAlertState =
  | "idle"
  | "ai_done"
  | "note_due_soon"
  | "note_overdue"
  | "note_reminder"
  | "mail_new_future"
  | "multiple";

/** Lower = higher priority (§7.3, with reminder slotted after due_soon). */
export function taoAlertPriority(kind: TaoAlertKind): number {
  switch (kind) {
    case "note_overdue":
      return 0;
    case "note_due_soon":
      return 1;
    case "note_reminder":
      return 2;
    case "ai_done":
      return 3;
    case "mail_new":
      return 4;
  }
}

/** Map a pending notes alert into the unified model. */
export function noteAlertToTao(alert: NoteAlert): TaoAlert {
  const kind: TaoAlertKind =
    alert.kind === "overdue"
      ? "note_overdue"
      : alert.kind === "due_soon"
        ? "note_due_soon"
        : "note_reminder";
  return {
    id: `note:${alert.id}`,
    source: "notes",
    kind,
    title: alert.note_title,
    noteId: alert.note_id,
    fireAt: alert.fire_at,
  };
}

/**
 * Merge pending notes alerts with chat ai_done alerts into one priority-sorted
 * list (highest severity first, then earliest fire time).
 */
export function buildTaoAlerts(
  noteAlerts: NoteAlert[],
  aiDone: TaoAlert[],
  mailNew: TaoAlert[] = [],
): TaoAlert[] {
  const fromNotes = (noteAlerts ?? []).filter((a) => a.state === "pending").map(noteAlertToTao);
  const merged = [...fromNotes, ...(aiDone ?? []), ...(mailNew ?? [])];
  merged.sort((a, b) => {
    const pa = taoAlertPriority(a.kind);
    const pb = taoAlertPriority(b.kind);
    return pa !== pb ? pa - pb : a.fireAt - b.fireAt;
  });
  return merged;
}

/** Reduce the alert list to a single ribbon state (§7.2). */
export function ribbonAlertState(alerts: TaoAlert[]): RibbonAlertState {
  if (alerts.length === 0) return "idle";
  if (alerts.length > 1) return "multiple";
  switch (alerts[0].kind) {
    case "note_overdue":
      return "note_overdue";
    case "note_due_soon":
      return "note_due_soon";
    case "note_reminder":
      return "note_reminder";
    case "ai_done":
      return "ai_done";
    case "mail_new":
      return "mail_new_future";
  }
}

/** Highest-severity kind present (drives the badge color when multiple). */
export function topAlertKind(alerts: TaoAlert[]): TaoAlertKind | null {
  return alerts.length > 0 ? alerts[0].kind : null;
}

/** Badge color bucket for a kind: red (overdue), amber (due/reminder), accent (ai/mail). */
export function alertColorBucket(kind: TaoAlertKind | null): "none" | "red" | "amber" | "accent" {
  if (kind === null) return "none";
  if (kind === "note_overdue") return "red";
  if (kind === "note_due_soon" || kind === "note_reminder") return "amber";
  return "accent";
}
