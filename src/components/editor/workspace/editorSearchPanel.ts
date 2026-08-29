import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";

function button(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-workspace-search-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function input(
  label: string,
  name: string,
  placeholder: string,
  type: "search" | "text" = "text",
): HTMLInputElement {
  const element = document.createElement("input");
  element.type = type;
  element.className = "cm-workspace-search-input";
  element.name = name;
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.autocomplete = "off";
  element.spellcheck = false;
  return element;
}

function fieldShell(field: HTMLInputElement): HTMLDivElement {
  const shell = document.createElement("div");
  shell.className = "cm-workspace-search-field";
  shell.append(field);
  return shell;
}

function matchStatus(view: EditorView, query: SearchQuery): string {
  if (!query.search) return "0 matches";
  if (!query.valid) return "Invalid pattern";
  const matches: Array<{ from: number; to: number }> = [];
  const cursor = query.getCursor(view.state);
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    matches.push(item.value);
  }
  if (matches.length === 0) return "0 matches";
  const selection = view.state.selection.main;
  const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  return current === -1 ? `${matches.length} matches` : `${current + 1} / ${matches.length}`;
}

export type CasingStyle = "upper" | "lower" | "title" | "camel" | "pascal" | "other";

export function detectCasing(text: string): CasingStyle {
  if (!text) return "other";
  if (text === text.toUpperCase() && text !== text.toLowerCase()) return "upper";
  if (text === text.toLowerCase() && text !== text.toUpperCase()) return "lower";
  if (/^[A-Z][a-z0-9]*$/.test(text)) return "title";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text.slice(1))) return "pascal";
  if (/^[a-z][a-zA-Z0-9]*$/.test(text) && /[A-Z]/.test(text)) return "camel";
  return "other";
}

export function applyPreserveCase(originalMatch: string, replacement: string): string {
  if (!originalMatch || !replacement) return replacement;
  const casing = detectCasing(originalMatch);
  switch (casing) {
    case "upper":
      return replacement.toUpperCase();
    case "lower":
      return replacement.toLowerCase();
    case "title":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    case "pascal":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    case "camel":
      return replacement.charAt(0).toLowerCase() + replacement.slice(1);
    default:
      return replacement;
  }
}

export function replaceNextPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
): boolean {
  if (!query.valid || !query.search) return false;
  if (!preserveCase) return replaceNext(view);

  const sel = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let targetMatch: { from: number; to: number } | null = null;
  let nextMatch: { from: number; to: number } | null = null;

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (item.value.from === sel.from && item.value.to === sel.to) {
      targetMatch = item.value;
      const next = cursor.next();
      if (!next.done) nextMatch = next.value;
      break;
    } else if (item.value.from >= sel.to && !targetMatch) {
      targetMatch = item.value;
      break;
    }
  }

  // If no match found at or after current selection, wrap around to first match
  if (!targetMatch) {
    const wrapCursor = query.getCursor(view.state);
    const first = wrapCursor.next();
    if (!first.done) targetMatch = first.value;
  }

  if (!targetMatch) return false;

  const matchedText = view.state.sliceDoc(targetMatch.from, targetMatch.to);
  const replacement = applyPreserveCase(matchedText, query.replace);

  view.dispatch({
    changes: { from: targetMatch.from, to: targetMatch.to, insert: replacement },
    selection: { anchor: targetMatch.from + replacement.length },
    scrollIntoView: true,
    userEvent: "input.replace",
  });

  // After replacing, advance selection to the next match if found
  if (!nextMatch) {
    const freshCursor = query.getCursor(view.state, targetMatch.from + replacement.length);
    const next = freshCursor.next();
    if (!next.done) {
      view.dispatch({
        selection: { anchor: next.value.from, head: next.value.to },
        scrollIntoView: true,
      });
    }
  } else {
    const offset = replacement.length - matchedText.length;
    view.dispatch({
      selection: { anchor: nextMatch.from + offset, head: nextMatch.to + offset },
      scrollIntoView: true,
    });
  }

  return true;
}

export function replaceAllPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
): boolean {
  if (!query.valid || !query.search) return false;
  if (!preserveCase) return replaceAll(view);

  const cursor = query.getCursor(view.state);
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    const matchedText = view.state.sliceDoc(item.value.from, item.value.to);
    const replacement = applyPreserveCase(matchedText, query.replace);
    changes.push({ from: item.value.from, to: item.value.to, insert: replacement });
  }

  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    userEvent: "input.replace.all",
  });

  return true;
}

class WorkspaceSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly wordButton: HTMLButtonElement;
  private readonly regexpButton: HTMLButtonElement;
  private readonly preserveCaseButton: HTMLButtonElement;
  private readonly status: HTMLSpanElement;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    // type=search lets the platform show a native clear; do not add a custom ×.
    this.searchField = input("Find", "search", "Find", "search");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = input("Replace", "replace", "Replace", "text");
    this.caseButton = button("Match case", "Aa", () => this.toggle("caseSensitive"));
    this.wordButton = button("Match whole word", "W", () => this.toggle("wholeWord"));
    this.regexpButton = button("Use regular expression", ".*", () => this.toggle("regexp"));
    this.preserveCaseButton = button("Preserve case", "AB/ab", () => this.togglePreserveCase());
    this.status = document.createElement("span");
    this.status.className = "cm-workspace-search-status";
    this.status.setAttribute("aria-live", "polite");

    const findRow = document.createElement("div");
    findRow.className = "cm-workspace-search-row";
    findRow.append(
      fieldShell(this.searchField),
      this.caseButton,
      this.wordButton,
      this.regexpButton,
      this.status,
      button("Previous match", "↑", () => findPrevious(this.view)),
      button("Next match", "↓", () => findNext(this.view)),
      button("Close find and replace", "×", () => closeSearchPanel(this.view)),
    );

    const replaceRow = document.createElement("div");
    replaceRow.className = "cm-workspace-search-row cm-workspace-replace-row";
    replaceRow.append(
      fieldShell(this.replaceField),
      this.preserveCaseButton,
      button("Replace current match", "Replace", () => this.handleReplaceNext()),
      button("Replace all matches", "Replace All", () => this.handleReplaceAll()),
    );

    this.dom = document.createElement("div");
    this.dom.className = "cm-workspace-search";
    this.dom.setAttribute("data-testid", "code-workspace-editor-search");
    this.dom.append(findRow, replaceRow);
    this.dom.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.searchField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    this.syncQuery(this.query);
  }

  mount(): void {
    this.searchField.select();
  }

  update(update: ViewUpdate): void {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.syncQuery(effect.value);
        }
      }
    }
    if (update.docChanged || update.selectionSet) this.updateStatus();
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseButton.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordButton.getAttribute("aria-pressed") === "true",
      regexp: this.regexpButton.getAttribute("aria-pressed") === "true",
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.updateStatus();
  }

  private toggle(field: "caseSensitive" | "wholeWord" | "regexp"): void {
    const target = field === "caseSensitive"
      ? this.caseButton
      : field === "wholeWord"
        ? this.wordButton
        : this.regexpButton;
    target.setAttribute("aria-pressed", target.getAttribute("aria-pressed") !== "true" ? "true" : "false");
    this.commit();
    this.searchField.focus();
  }

  private togglePreserveCase(): void {
    const current = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    this.preserveCaseButton.setAttribute("aria-pressed", current ? "false" : "true");
    this.replaceField.focus();
  }

  private handleReplaceNext(): void {
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    replaceNextPreserveCase(this.view, this.query, isPreserveCase);
    this.updateStatus();
  }

  private handleReplaceAll(): void {
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    replaceAllPreserveCase(this.view, this.query, isPreserveCase);
    this.updateStatus();
  }

  private syncQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseButton.setAttribute("aria-pressed", String(query.caseSensitive));
    this.wordButton.setAttribute("aria-pressed", String(query.wholeWord));
    this.regexpButton.setAttribute("aria-pressed", String(query.regexp));
    this.updateStatus();
  }

  private updateStatus(): void {
    this.status.textContent = matchStatus(this.view, this.query);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(this.view);
      return;
    }
    if (event.key === "F3" || (event.key === "Enter" && event.target === this.searchField)) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
      return;
    }
    if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault();
      this.handleReplaceNext();
    }
  }
}

export function createWorkspaceSearchPanel(view: EditorView): Panel {
  return new WorkspaceSearchPanel(view);
}

export const WORKSPACE_SEARCH_STYLE = EditorView.theme({
  ".cm-panels-top": {
    borderBottom: "1px solid var(--taomni-code-border)",
  },
  ".cm-panel.cm-workspace-search": {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "6px 8px",
    background: "var(--taomni-code-gutter-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "11px",
  },
  ".cm-workspace-search-row": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
  },
  ".cm-workspace-search-field": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    width: "min(320px, 45%)",
    minWidth: "120px",
  },
  ".cm-workspace-search-input": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    height: "26px",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "4px",
    padding: "0 7px",
    outline: "none",
    background: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
    font: "inherit",
  },
  '.cm-workspace-search-input[type="search"]': {
    // Do not set appearance:none — it can suppress the platform clear control.
    WebkitAppearance: "textfield",
  },
  ".cm-workspace-search-input:focus": {
    borderColor: "var(--taomni-accent)",
  },
  ".cm-workspace-search-button": {
    boxSizing: "border-box",
    height: "26px",
    minWidth: "26px",
    border: "1px solid transparent",
    borderRadius: "4px",
    padding: "0 6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-workspace-search-button:hover": {
    background: "var(--taomni-code-active-line-bg)",
  },
  '.cm-workspace-search-button[aria-pressed="true"]': {
    borderColor: "var(--taomni-code-border)",
    background: "var(--taomni-code-selection-match-bg)",
    color: "var(--taomni-accent)",
  },
  ".cm-workspace-search-status": {
    minWidth: "64px",
    marginLeft: "4px",
    color: "var(--taomni-code-muted)",
    whiteSpace: "nowrap",
  },
  ".cm-workspace-replace-row": {
    paddingLeft: "0",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--taomni-code-selection-match-bg)",
    outline: "1px solid color-mix(in srgb, var(--taomni-accent) 45%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--taomni-accent) 32%, transparent)",
  },
});
