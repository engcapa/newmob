import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Anchor,
  Bold,
  ChevronDown,
  Eraser,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Table2,
  Smile,
  Underline,
} from "lucide-react";
import { markdownToMailHtml, mailHtmlToPlainText, sanitizeMailComposeHtml } from "../../lib/mailHtml";
import { readClipboardImageFiles, readMultiFormat, readText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { isOsFileDrag, preventDefaultForOsFileDrag } from "../../lib/osFileDrop";
import { useContextMenu, type MenuItem } from "../ContextMenu";

interface RichMailEditorProps {
  html: string;
  disabled?: boolean;
  onChange: (html: string, text: string) => void;
  onRichFormatUsed?: () => void;
  onAttach?: () => void;
  onInlineImage?: () => string | null | Promise<string | null>;
  /** Paste / drop image blobs → parent returns insertable HTML snippets (data URL + cid metadata). */
  onPasteImages?: (files: File[]) => Promise<string[]>;
  /** Non-image file drops should become regular attachments. */
  onDropFiles?: (files: File[]) => void | Promise<void>;
  dragActive?: boolean;
}

const PARAGRAPH_OPTIONS = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "blockquote", label: "Quote" },
  { value: "pre", label: "Preformatted" },
];

const FONT_OPTIONS = [
  { value: "Arial", label: "Arial" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times" },
  { value: "Courier New", label: "Courier" },
  { value: "Inter", label: "Inter" },
];

const SIZE_OPTIONS = [
  { value: "2", label: "12" },
  { value: "3", label: "14" },
  { value: "4", label: "18" },
  { value: "5", label: "24" },
];

const EMOJI_OPTIONS = [
  { id: "smile", label: "微笑", value: "🙂" },
  { id: "frown", label: "皱眉", value: "🙁" },
  { id: "wink", label: "眨眼", value: "😉" },
  { id: "tongue", label: "吐舌", value: "😛" },
  { id: "laugh", label: "大笑", value: "😂" },
  { id: "blush", label: "窘迫", value: "😳" },
  { id: "unsure", label: "迟疑", value: "😕" },
  { id: "surprise", label: "惊讶", value: "😮" },
  { id: "kiss", label: "亲吻", value: "😘" },
  { id: "shout", label: "大叫", value: "😱" },
  { id: "cool", label: "酷", value: "😎" },
  { id: "money", label: "爱财", value: "🤑" },
  { id: "sealed", label: "失言", value: "😶" },
  { id: "innocent", label: "无辜", value: "😇" },
  { id: "cry", label: "哭泣", value: "😭" },
  { id: "silent", label: "缄默", value: "🤐" },
];

export function RichMailEditor({
  html,
  disabled = false,
  onChange,
  onRichFormatUsed,
  onAttach,
  onInlineImage,
  onPasteImages,
  onDropFiles,
  dragActive = false,
}: RichMailEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [color, setColor] = useState("#1f2937");
  const [localDrag, setLocalDrag] = useState(false);
  const editorMenu = useContextMenu();
  const t = useT();

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = html || "<p><br></p>";
    if (editor.innerHTML !== next) editor.innerHTML = next;
  }, [html]);

  const emitChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextHtml = editor.innerHTML || "<p><br></p>";
    onChange(nextHtml, mailHtmlToPlainText(nextHtml));
  };

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const isRangeInEditor = (range: Range | null): range is Range => {
    const editor = editorRef.current;
    return !!editor && !!range && editor.contains(range.commonAncestorContainer);
  };

  const saveSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && isRangeInEditor(selection.getRangeAt(0))) {
      selectionRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const range = selectionRef.current;
    if (!isRangeInEditor(range)) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const focusAndRestoreSelection = () => {
    focusEditor();
    restoreSelection();
  };

  const exec = (command: string, value?: string, rich = true) => {
    if (disabled) return;
    focusAndRestoreSelection();
    document.execCommand(command, false, value);
    saveSelection();
    if (rich) onRichFormatUsed?.();
    emitChange();
  };

  const insertHtml = (value: string, rich = true) => {
    if (disabled || !value) return;
    focusAndRestoreSelection();
    document.execCommand("insertHTML", false, value);
    saveSelection();
    if (rich) onRichFormatUsed?.();
    emitChange();
  };

  const pasteClipboard = async (mode: "normal" | "plain" | "markdown") => {
    if (disabled) return;
    if (mode === "plain" || mode === "markdown") {
      const text = await readText();
      if (!text.trim()) return;
      insertHtml(mode === "markdown" ? markdownToMailHtml(text) : plainTextFragment(text), mode === "markdown");
      return;
    }
    const data = await readMultiFormat();
    const imageFiles = await readClipboardImageFiles();
    if (onPasteImages && imageFiles.length > 0) {
      const snippets = await onPasteImages(imageFiles);
      for (const snippet of snippets) insertHtml(snippet, true);
      return;
    }
    if (onPasteImages && !data.html?.trim() && !data.text.trim()) {
      const snippets = await onPasteImages([]);
      for (const snippet of snippets) insertHtml(snippet, true);
      return;
    }
    if (data.html?.trim()) {
      insertHtml(sanitizeMailComposeHtml(data.html), true);
    } else if (data.text) {
      insertHtml(plainTextFragment(data.text), false);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    const pastedHtml = event.clipboardData?.getData("text/html") ?? "";
    const pastedText = event.clipboardData?.getData("text/plain") ?? "";
    const imageFiles = clipboardImageFiles(event.clipboardData);
    const maybeNativeImageOnly =
      !!onPasteImages && imageFiles.length === 0 && !pastedHtml.trim() && !pastedText.trim();

    if (onPasteImages && (imageFiles.length > 0 || maybeNativeImageOnly)) {
      event.preventDefault();
      void (async () => {
        try {
          const snippets = await onPasteImages(imageFiles);
          for (const snippet of snippets) {
            if (snippet) insertHtml(snippet, true);
          }
        } catch {
          // Parent surfaces errors via compose status/compose error.
        }
      })();
      return;
    }

    event.preventDefault();
    if (pastedHtml) {
      insertHtml(sanitizeMailComposeHtml(pastedHtml), true);
    } else if (pastedText) {
      insertHtml(plainTextFragment(pastedText), false);
    }
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (!isOsFileDrag(event.dataTransfer) && !hasFilePayload(event.dataTransfer)) return;
    preventDefaultForOsFileDrag(event);
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setLocalDrag(true);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!editorRef.current?.contains(event.relatedTarget as Node | null)) {
      setLocalDrag(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (disabled) return;
    setLocalDrag(false);
    if (!isOsFileDrag(event.dataTransfer) && !hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;

    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));

    void (async () => {
      if (images.length > 0 && onPasteImages) {
        try {
          const snippets = await onPasteImages(images);
          for (const snippet of snippets) {
            if (snippet) insertHtml(snippet, true);
          }
        } catch {
          // Parent surfaces errors.
        }
      }
      if (others.length > 0 && onDropFiles) {
        await onDropFiles(others);
      } else if (images.length === 0 && others.length === 0 && onDropFiles) {
        await onDropFiles(files);
      }
    })();
  };

  const handleLink = () => {
    const href = window.prompt("Link URL");
    if (!href?.trim()) return;
    exec("createLink", href.trim());
  };

  const handleAnchor = () => {
    const name = window.prompt("Anchor name");
    const cleaned = name?.trim().replace(/\s+/g, "-");
    if (!cleaned) return;
    insertHtml(`<a name="${escapeHtml(cleaned)}"></a>`, true);
  };

  const handleInlineImage = async () => {
    const imageHtml = await onInlineImage?.();
    if (!imageHtml) return;
    insertHtml(imageHtml, true);
  };

  const handleTable = () => {
    const raw = window.prompt("Table size (columns x rows)", "2x2");
    if (!raw) return;
    const match = /^\s*(\d{1,2})\s*[x*,]\s*(\d{1,2})\s*$/i.exec(raw);
    const cols = Math.max(1, Math.min(12, Number(match?.[1] ?? 2)));
    const rows = Math.max(1, Math.min(20, Number(match?.[2] ?? 2)));
    insertHtml(buildTableHtml(cols, rows), true);
  };

  const showMenu = (event: ReactMouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    editorMenu.showAt(rect.left, rect.bottom + 4, items);
  };

  const emojiMenuItems = (): MenuItem[] => EMOJI_OPTIONS.map((emoji) => ({
    label: `${emoji.value} ${emoji.label}`,
    testId: `mail-compose-emoji-${emoji.id}`,
    onClick: () => insertHtml(emoji.value, false),
  }));

  const editingMenuItems = (): MenuItem[] => [
    { label: t("contextMenu.undo"), testId: "mail-compose-context-undo", shortcut: shortcut("Z"), onClick: () => exec("undo", undefined, false) },
    { label: t("contextMenu.redo"), testId: "mail-compose-context-redo", shortcut: shortcut("Y"), onClick: () => exec("redo", undefined, false) },
    { label: "", separator: true },
    { label: t("contextMenu.cut"), testId: "mail-compose-context-cut", shortcut: shortcut("X"), onClick: () => exec("cut", undefined, false) },
    { label: t("contextMenu.copy"), testId: "mail-compose-context-copy", shortcut: shortcut("C"), onClick: () => exec("copy", undefined, false) },
    { label: t("contextMenu.paste"), testId: "mail-compose-context-paste", shortcut: shortcut("V"), onClick: () => void pasteClipboard("normal") },
    { label: t("contextMenu.pasteAsPlainText"), testId: "mail-compose-paste-plain-text", onClick: () => void pasteClipboard("plain") },
    { label: t("contextMenu.pasteAsMarkdown"), testId: "mail-compose-paste-markdown", onClick: () => void pasteClipboard("markdown") },
    { label: "", separator: true },
    { label: t("contextMenu.selectAll"), testId: "mail-compose-context-select-all", shortcut: shortcut("A"), onClick: () => exec("selectAll", undefined, false) },
  ];

  const handleEditorContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const selection = window.getSelection();
    const hasSelectedText = !!selection && selection.rangeCount > 0 && !selection.isCollapsed && isRangeInEditor(selection.getRangeAt(0));
    if (!hasSelectedText) placeCaretAtPoint(event.clientX, event.clientY);
    saveSelection();
    editorMenu.show(event, editingMenuItems());
  };

  const insertMenuItems = (): MenuItem[] => [
    {
      label: "链接",
      testId: "mail-compose-insert-link",
      icon: <LinkIcon className="w-3.5 h-3.5" />,
      onClick: handleLink,
    },
    {
      label: "锚标",
      testId: "mail-compose-insert-anchor",
      icon: <Anchor className="w-3.5 h-3.5" />,
      onClick: handleAnchor,
    },
    {
      label: "图像",
      testId: "mail-compose-insert-image",
      icon: <ImageIcon className="w-3.5 h-3.5" />,
      disabled: !onInlineImage,
      onClick: () => void handleInlineImage(),
    },
    {
      label: "水平线",
      testId: "mail-compose-insert-hr",
      icon: <Minus className="w-3.5 h-3.5" />,
      onClick: () => insertHtml("<hr>", true),
    },
    {
      label: "表格",
      testId: "mail-compose-insert-table",
      icon: <Table2 className="w-3.5 h-3.5" />,
      onClick: handleTable,
    },
  ];

  const showDrag = dragActive || localDrag;

  return (
    <div
      className={`mx-3 mb-3 min-h-0 flex-1 flex flex-col border rounded-md overflow-hidden bg-[var(--taomni-input-bg)] ${
        showDrag
          ? "border-[var(--taomni-accent)] ring-1 ring-[var(--taomni-accent)]"
          : "border-[var(--taomni-input-border)]"
      }`}
      data-testid="mail-compose-editor-shell"
      data-drag-active={showDrag ? "true" : "false"}
    >
      <div
        className="min-h-9 px-2 py-1 flex flex-wrap items-center gap-1 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]"
        data-testid="mail-compose-format-toolbar"
      >
        <select
          className="taomni-input h-7 w-[104px] text-[12px]"
          aria-label="Paragraph style"
          data-testid="mail-compose-format-block"
          disabled={disabled}
          onChange={(event) => exec("formatBlock", event.target.value)}
        >
          {PARAGRAPH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="taomni-input h-7 w-[120px] text-[12px]"
          aria-label="Font family"
          data-testid="mail-compose-font-family"
          disabled={disabled}
          onChange={(event) => exec("fontName", event.target.value)}
        >
          {FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="taomni-input h-7 w-[64px] text-[12px]"
          aria-label="Font size"
          data-testid="mail-compose-font-size"
          disabled={disabled}
          onChange={(event) => exec("fontSize", event.target.value)}
        >
          {SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          type="color"
          className="h-7 w-8 rounded border border-[var(--taomni-input-border)] bg-transparent"
          aria-label="Text color"
          title="Text color"
          data-testid="mail-compose-text-color"
          value={color}
          disabled={disabled}
          onChange={(event) => {
            setColor(event.target.value);
            exec("foreColor", event.target.value);
          }}
        />
        <ToolbarButton label="Bold" testId="mail-compose-bold" disabled={disabled} onClick={() => exec("bold")}><Bold className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Italic" testId="mail-compose-italic" disabled={disabled} onClick={() => exec("italic")}><Italic className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Underline" testId="mail-compose-underline" disabled={disabled} onClick={() => exec("underline")}><Underline className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Clear formatting" testId="mail-compose-clear-format" disabled={disabled} onClick={() => exec("removeFormat")}><Eraser className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Bulleted list" testId="mail-compose-bullet-list" disabled={disabled} onClick={() => exec("insertUnorderedList")}><List className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Numbered list" testId="mail-compose-number-list" disabled={disabled} onClick={() => exec("insertOrderedList")}><ListOrdered className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Decrease indent" testId="mail-compose-outdent" disabled={disabled} onClick={() => exec("outdent")}><IndentDecrease className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Increase indent" testId="mail-compose-indent" disabled={disabled} onClick={() => exec("indent")}><IndentIncrease className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align left" testId="mail-compose-align-left" disabled={disabled} onClick={() => exec("justifyLeft")}><AlignLeft className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align center" testId="mail-compose-align-center" disabled={disabled} onClick={() => exec("justifyCenter")}><AlignCenter className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align right" testId="mail-compose-align-right" disabled={disabled} onClick={() => exec("justifyRight")}><AlignRight className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Insert link" testId="mail-compose-link" disabled={disabled} onClick={handleLink}><LinkIcon className="w-3.5 h-3.5" /></ToolbarButton>
        <MenuButton label="Insert" testId="mail-compose-insert-menu" disabled={disabled} onClick={(event) => showMenu(event, insertMenuItems())}>
          <ImageIcon className="w-3.5 h-3.5" />
        </MenuButton>
        <MenuButton label="Insert emoticon" testId="mail-compose-emoji" disabled={disabled} onClick={(event) => showMenu(event, emojiMenuItems())}>
          <Smile className="w-3.5 h-3.5" />
        </MenuButton>
        {onAttach && (
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-[12px]"
            data-testid="mail-compose-attach"
            disabled={disabled}
            onClick={onAttach}
            title="Attach files"
          >
            Attach
          </button>
        )}
      </div>
      {editorMenu.render}
      <div className="relative flex-1 min-h-[240px] flex flex-col">
        <div
          ref={editorRef}
          className="flex-1 min-h-[240px] overflow-auto px-3 py-2 text-[13px] leading-6 outline-none bg-[var(--taomni-input-bg)] empty:before:content-['']"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-label="Message body"
          data-testid="mail-compose-editor"
          onInput={() => {
            saveSelection();
            emitChange();
          }}
          onPaste={handlePaste}
          onContextMenu={handleEditorContextMenu}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />
        {showDrag && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--taomni-accent)]/10 text-[12px] font-medium text-[var(--taomni-accent)]"
            data-testid="mail-compose-drop-hint"
          >
            Drop files to attach · drop images to insert inline
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MenuButton({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 px-1.5 inline-flex items-center justify-center gap-0.5"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <ChevronDown className="w-3 h-3" />
    </button>
  );
}

function buildTableHtml(cols: number, rows: number): string {
  const cells = Array.from({ length: cols }, () => (
    '<td style="border: 1px solid #9ca3af; padding: 4px 8px;">&nbsp;</td>'
  )).join("");
  const body = Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("");
  return `<table style="border-collapse: collapse;"><tbody>${body}</tbody></table><p><br></p>`;
}

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

function hasFilePayload(data: DataTransfer | null): boolean {
  if (!data) return false;
  if ((data.files?.length ?? 0) > 0) return true;
  return Array.from(data.types ?? []).some((type) => type === "Files" || type === "text/uri-list");
}

function placeCaretAtPoint(x: number, y: number): void {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const selection = window.getSelection();
  if (!selection) return;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function plainTextFragment(value: string): string {
  return escapeHtml(value).replace(/\r\n?|\n/g, "<br>");
}

function shortcut(key: string): string {
  return `${navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"}+${key}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
