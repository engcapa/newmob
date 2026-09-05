import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from "@codemirror/view";
import { Chunk } from "@codemirror/merge";
import type { GitBlameLine } from "../../../lib/git";

export type GitLineChangeKind = "added" | "modified" | "deleted";

export interface GitLineChange {
  kind: GitLineChangeKind;
  startLine: number;
  endLine: number;
  oldStartLine: number;
  oldEndLine: number;
  oldText: string;
  newText: string;
}

function changedLineRange(doc: Text, from: number, to: number): { start: number; end: number; text: string } | null {
  if (from === to) return null;
  const safeFrom = Math.min(from, doc.length);
  const safeEnd = Math.min(Math.max(from, to - 1), doc.length);
  return {
    start: doc.lineAt(safeFrom).number - 1,
    end: doc.lineAt(safeEnd).number - 1,
    text: doc.sliceString(safeFrom, Math.min(to, doc.length)).replace(/\n$/, ""),
  };
}

export function buildGitLineChanges(headText: string, bufferText: string): GitLineChange[] {
  if (headText === bufferText) return [];
  const head = Text.of(headText.split("\n"));
  const buffer = Text.of(bufferText.split("\n"));
  return Chunk.build(head, buffer, { scanLimit: 5000, timeout: 120 }).map((chunk) => {
    const oldRange = changedLineRange(head, chunk.fromA, chunk.toA);
    const newRange = changedLineRange(buffer, chunk.fromB, chunk.toB);
    const anchor = buffer.lineAt(Math.min(chunk.fromB, buffer.length)).number - 1;
    return {
      kind: !oldRange ? "added" : !newRange ? "deleted" : "modified",
      startLine: newRange?.start ?? Math.min(anchor, buffer.lines - 1),
      endLine: newRange?.end ?? Math.min(anchor, buffer.lines - 1),
      oldStartLine: oldRange?.start ?? Math.max(0, head.lineAt(Math.min(chunk.fromA, head.length)).number - 1),
      oldEndLine: oldRange?.end ?? Math.max(0, head.lineAt(Math.min(chunk.fromA, head.length)).number - 1),
      oldText: oldRange?.text ?? "",
      newText: newRange?.text ?? "",
    };
  });
}

export function rollbackGitLineChange(docText: string, change: GitLineChange): string {
  const lines = docText.split("\n");
  const oldLines = change.oldText ? change.oldText.split("\n") : [];

  if (change.kind === "added") {
    const deleteCount = Math.max(1, change.endLine - change.startLine + 1);
    lines.splice(change.startLine, deleteCount);
    return lines.join("\n");
  }

  if (change.kind === "deleted") {
    lines.splice(change.startLine, 0, ...oldLines);
    return lines.join("\n");
  }

  if (change.kind === "modified") {
    const deleteCount = Math.max(1, change.endLine - change.startLine + 1);
    lines.splice(change.startLine, deleteCount, ...oldLines);
    return lines.join("\n");
  }

  return docText;
}

function changeColor(kind: GitLineChangeKind): string {
  if (kind === "added") return "var(--taomni-code-syntax-inserted, #22c55e)";
  if (kind === "deleted") return "var(--taomni-code-syntax-deleted, #ef4444)";
  return "var(--taomni-code-syntax-changed, #3b82f6)";
}

class GitChangeMarker extends GutterMarker {
  constructor(
    readonly change: GitLineChange,
    readonly onClick?: (change: GitLineChange) => void,
  ) {
    super();
  }

  eq(other: GitChangeMarker): boolean {
    return !this.onClick && !other.onClick
      && other.change.kind === this.change.kind
      && other.change.startLine === this.change.startLine
      && other.change.endLine === this.change.endLine;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-git-change-marker cm-git-change-${this.change.kind}`;
    button.style.setProperty("--cm-git-change-color", changeColor(this.change.kind));
    button.title = `${this.change.kind[0].toUpperCase()}${this.change.kind.slice(1)} lines · show diff`;
    button.setAttribute("aria-label", `${this.change.kind} Git change · show diff`);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClick?.(this.change);
    });
    return button;
  }
}

export function formatBlameAge(authorTime: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - authorTime * 1000);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function blameLabel(blame: GitBlameLine): string {
  if (/^0+$/.test(blame.commit)) return "Uncommitted change";
  return `${blame.author}, ${formatBlameAge(blame.authorTime)} · ${blame.summary}`;
}

class InlineBlameWidget extends WidgetType {
  constructor(readonly blame: GitBlameLine) {
    super();
  }

  eq(other: InlineBlameWidget): boolean {
    return other.blame.commit === this.blame.commit
      && other.blame.line === this.blame.line
      && other.blame.summary === this.blame.summary;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-git-blame";
    span.textContent = blameLabel(this.blame);
    span.title = `${this.blame.commit.slice(0, 10)} · ${this.blame.author}${this.blame.authorMail ? ` <${this.blame.authorMail}>` : ""}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Module-level to keep the extension identity stable across reconfigures. */
const GIT_EDITOR_THEME = EditorView.theme({
  ".cm-git-change-gutter": { width: "5px" },
  ".cm-git-change-gutter .cm-gutterElement": { padding: "0" },
  ".cm-git-change-marker": {
    display: "block",
    width: "4px",
    height: "100%",
    minHeight: "1.2em",
    border: "none",
    padding: "0",
    background: "var(--cm-git-change-color)",
    cursor: "pointer",
  },
  ".cm-git-change-deleted": {
    height: "0",
    minHeight: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--cm-git-change-color)",
    background: "transparent",
  },
  ".cm-inline-git-blame": {
    marginLeft: "2.5rem",
    color: "var(--taomni-code-muted)",
    opacity: "0.66",
    fontSize: "0.9em",
    fontStyle: "italic",
    whiteSpace: "nowrap",
    userSelect: "none",
    pointerEvents: "none",
  },
});

interface GitEditorChromeConfig {
  changes: readonly GitLineChange[];
  blame: GitBlameLine | null;
  onChangeClick?: (change: GitLineChange) => void;
}

interface GitEditorChromeState extends GitEditorChromeConfig {
  markers: RangeSet<GutterMarker>;
}

const setGitEditorChromeState = StateEffect.define<GitEditorChromeConfig>();

function buildGitChangeMarkers(
  doc: Text,
  { changes, onChangeClick }: GitEditorChromeConfig,
): RangeSet<GutterMarker> {
  const lineChanges = new Map<number, GitLineChange>();
  for (const change of changes) {
    for (let line = change.startLine; line <= change.endLine; line += 1) {
      lineChanges.set(line, change);
    }
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const [lineNumber, change] of [...lineChanges].sort(([left], [right]) => left - right)) {
    if (lineNumber < 0 || lineNumber >= doc.lines) continue;
    const line = doc.line(lineNumber + 1);
    builder.add(line.from, line.from, new GitChangeMarker(change, onChangeClick));
  }
  return builder.finish();
}

const gitEditorChromeState = StateField.define<GitEditorChromeState>({
  create: () => ({ changes: [], blame: null, markers: RangeSet.empty }),
  update: (current, transaction) => {
    let config: GitEditorChromeConfig = current;
    for (const effect of transaction.effects) {
      if (effect.is(setGitEditorChromeState)) config = effect.value;
    }
    if (config === current && !transaction.docChanged) return current;
    return {
      ...config,
      markers: buildGitChangeMarkers(transaction.newDoc, config),
    };
  },
});

const GIT_CHANGE_GUTTER = gutter({
  class: "cm-git-change-gutter",
  markers: (view) => view.state.field(gitEditorChromeState).markers,
});

const GIT_BLAME_DECORATIONS = EditorView.decorations.compute(
  ["doc", gitEditorChromeState],
  (state) => {
    const { blame } = state.field(gitEditorChromeState);
    if (!blame || blame.line < 1 || blame.line > state.doc.lines) return Decoration.none;
    const line = state.doc.line(blame.line);
    return Decoration.set([
      Decoration.widget({ widget: new InlineBlameWidget(blame), side: 1 }).range(line.to),
    ]);
  },
);

export function updateGitEditorChrome(
  changes: readonly GitLineChange[],
  blame: GitBlameLine | null,
  onChangeClick?: (change: GitLineChange) => void,
): StateEffect<GitEditorChromeConfig> {
  return setGitEditorChromeState.of({ changes, blame, onChangeClick });
}

export function createGitEditorChrome(
  changes: GitLineChange[],
  blame: GitBlameLine | null,
  onChangeClick?: (change: GitLineChange) => void,
): Extension[] {
  return [
    gitEditorChromeState.init((state) => {
      const config = { changes, blame, onChangeClick };
      return {
        ...config,
        markers: buildGitChangeMarkers(state.doc, config),
      };
    }),
    GIT_CHANGE_GUTTER,
    GIT_BLAME_DECORATIONS,
    GIT_EDITOR_THEME,
  ];
}
