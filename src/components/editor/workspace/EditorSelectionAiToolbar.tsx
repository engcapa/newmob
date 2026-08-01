import { BookOpen, GraduationCap, Languages, Sparkles, WandSparkles, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { AiAnswerLanguage, EditorAiAction } from "./editorAiPrompts";

export type { EditorAiAction } from "./editorAiPrompts";

interface EditorSelectionAiToolbarProps {
  visible: boolean;
  rect: { top: number; left: number; right: number; bottom: number } | null;
  selectionText: string;
  busy?: boolean;
  /** Language the AI should answer in; `auto` follows the app locale. */
  answerLanguage?: AiAnswerLanguage;
  onAction: (action: EditorAiAction, text: string) => void;
  /** Cycle the answer language. Omitted when the host does not persist it. */
  onCycleAnswerLanguage?: () => void;
  onDismiss: () => void;
}

const BUTTON_CLASS =
  "h-7 inline-flex items-center gap-1 rounded px-2 text-[11px] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40";

export function EditorSelectionAiToolbar({
  visible,
  rect,
  selectionText,
  busy = false,
  answerLanguage = "auto",
  onAction,
  onCycleAnswerLanguage,
  onDismiss,
}: EditorSelectionAiToolbarProps) {
  const t = useT();
  if (!visible || !rect || selectionText.trim().length < 2) return null;

  const TOOLBAR_HEIGHT = 34;
  const PADDING = 8;
  const placeAbove = rect.top > TOOLBAR_HEIGHT + PADDING;
  const top = placeAbove ? rect.top - TOOLBAR_HEIGHT - PADDING : rect.bottom + PADDING;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 480));

  const languageBadge = answerLanguage === "zh-CN"
    ? t("codeWorkspaceAi.answerLanguageZh")
    : answerLanguage === "en"
      ? t("codeWorkspaceAi.answerLanguageEn")
      : t("codeWorkspaceAi.answerLanguageAuto");

  return (
    <div
      data-testid="code-workspace-ai-selection-toolbar"
      className="fixed z-[420] flex items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] px-1 py-0.5 shadow-xl"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.explainTooltip")}
        onClick={() => onAction("explain", selectionText)}
      >
        <BookOpen className="h-3.5 w-3.5" />
        Explain
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.syntaxTooltip")}
        onClick={() => onAction("syntax", selectionText)}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        Syntax
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.fixTooltip")}
        onClick={() => onAction("fix", selectionText)}
      >
        <WandSparkles className="h-3.5 w-3.5" />
        Fix
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.rewriteTooltip")}
        onClick={() => onAction("rewrite", selectionText)}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask AI
      </button>
      {onCycleAnswerLanguage && (
        <button
          type="button"
          data-testid="code-workspace-ai-answer-language"
          className="h-7 inline-flex items-center gap-1 rounded border-l border-[var(--taomni-code-border)] pl-2 pr-2 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          title={t("codeWorkspaceAi.answerLanguageTooltip", { current: languageBadge })}
          onClick={onCycleAnswerLanguage}
        >
          <Languages className="h-3.5 w-3.5" />
          {languageBadge}
        </button>
      )}
      <button
        type="button"
        className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
        title="Dismiss AI toolbar"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
