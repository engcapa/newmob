# Tao Notes Architecture and Behavior

> Status: implemented. The historical development checklist has been removed; this document records the current storage, UI, alert, and testing contracts.

## Product model

Tao Notes combines notes, reminders, and lightweight tasks in one model. Every item is a note; task-like behavior comes from completion, due/reminder time, priority, steps, tags, pinning, color, and archive state.

The default view is “recent incomplete”. Users can create, edit, complete, reopen, archive, delete, search, and filter notes.

## Persistence

Notes live in a dedicated `notes.db` under the application data directory. Keeping it separate from `taomni.db` allows the schema, backup policy, and future encryption policy to evolve independently.

`src-tauri/src/notes/db.rs` owns the schema and queries:

- `notes`: title/body, completion, archive, pin, color, priority, due/reminder timestamps, and audit timestamps;
- `note_steps`: ordered checklist items;
- `note_tags` and `note_tag_links`: reusable tags and note membership;
- `note_prefs`: notes-specific preferences;
- `note_alert_events`: durable alert acknowledgement/deduplication state.

Schema initialization is idempotent. Note deletion cascades through owned steps/tag links/alerts. User-visible timestamps are stored as epoch values and formatted by the frontend.

## IPC boundary

`src-tauri/src/notes/commands.rs` exposes bounded commands for:

- list/get/create/update/delete;
- complete/reopen and archive/unarchive;
- list/upsert tags and replace steps;
- get/set preferences;
- list and acknowledge alerts.

The frontend wrapper is `src/lib/notes.ts`. Desktop persistence goes through Rust; browser preview mirrors the command contract with localStorage-backed stubs.

## Frontend state and UI

`src/stores/notesStore.ts` is the notes UI state boundary. It loads records, owns filters and selection, persists view preferences, and coordinates panel mode/theme.

Primary surfaces:

- `NotesPanel`: Tao Hub master/detail notes workspace;
- `NotesList`, `NoteEditor`, `NoteFilters`: browsing and editing;
- `NoteThemeSettings`: taomni/system/light/dark/paper/compact themes plus font settings;
- `FloatingNotesPanel`: a single in-app draggable/resizable overlay;
- `NotesDetachedWindow`: detached-window rendering;
- `TaoRibbon`: shared entry point for Chat, Notes, and alerts.

Panel mode, position, size, in-app always-on-top preference, theme, font, font size, and filters are persisted through stable preference keys. Overlay z-index must stay below authentication, vault, and other blocking system dialogs.

## Tao Hub and ribbon

Tao Hub contains Chat, Notes, and Notifications. It remembers the last non-notification tab. The ribbon can attach to any window edge using an edge plus normalized offset and displays bounded alert state without continuous distracting animation.

Chat docking and note panel placement share the main window but remain separate state models. Changes must not remount active terminal/database/RDP tabs or break the existing Chat Drawer lifecycle.

## Alerts

`TaoAlertPoller` and `taoAlertStore` merge:

- due-soon and overdue notes;
- completed background AI work;
- new-mail notifications.

The inbox supports navigation to the source, acknowledgement, searchable local history, and bounded retention. Acknowledging an alert must prevent duplicate delivery until the source state meaningfully changes, such as rescheduling a reminder.

## Security and privacy

- Note content is local application data and must not be sent to an AI provider merely because the Tao Hub is open.
- Any future AI action over note content must follow the same explicit context, redaction, provider, and confirmation rules as Chat attachments.
- Browser localStorage is a preview implementation, not a persistence/security equivalent to `notes.db`.
- Do not move notes into `taomni.db` without a migration and backup decision.

## Verification

- Rust tests in `src-tauri/src/notes/db.rs` cover schema, CRUD, filters, steps/tags, and alert acknowledgement.
- `src/stores/notesStore.test.ts` covers state and derived alert counts.
- Component tests cover NotesPanel and floating/detached behavior.
- Ribbon placement, chat dock, theme, and alert ordering have focused utility tests.
- UI coverage and stable controls are catalogued under F-TAO-1 in `qa-ui-auto-tests/feature-list.md`.

Real SQLite persistence, cross-process behavior, and native detached windows require desktop verification; browser smoke tests exercise the stub contract only.
