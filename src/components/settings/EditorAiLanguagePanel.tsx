import { useState } from "react";
import { Languages } from "lucide-react";
import {
  GLOBAL_ANSWER_LANGUAGES,
  readGlobalAnswerLanguage,
  writeGlobalAnswerLanguage,
  type GlobalAnswerLanguage,
} from "../../lib/ai/answerLanguage";
import { useT } from "../../lib/i18n";

/**
 * Global default answer language for the AI explanation features — the editor's
 * selection actions and the database statement explanations.
 *
 * localStorage-backed rather than part of the Rust-side AiConfig: this only
 * shapes prompt wording, and it joins an existing localStorage family of editor
 * AI preferences. A workspace that pinned its own language keeps it; the rest
 * follow this.
 */
export function EditorAiLanguagePanel() {
  const t = useT();
  const [current, setCurrent] = useState<GlobalAnswerLanguage>(readGlobalAnswerLanguage);

  const DESCRIPTIONS: Record<GlobalAnswerLanguage, string> = {
    auto: t("aiSettings.answerLanguageAutoDesc"),
    "zh-CN": t("aiSettings.answerLanguageZhDesc"),
    en: t("aiSettings.answerLanguageEnDesc"),
  };

  const LABELS: Record<GlobalAnswerLanguage, string> = {
    auto: t("aiSettings.answerLanguageAuto"),
    "zh-CN": t("aiSettings.answerLanguageZh"),
    en: t("aiSettings.answerLanguageEn"),
  };

  const update = (next: GlobalAnswerLanguage) => {
    if (next === current) return;
    writeGlobalAnswerLanguage(next);
    setCurrent(next);
  };

  return (
    <div className="space-y-2" data-testid="editor-ai-language-panel">
      <div className="flex items-center gap-2">
        <Languages className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="text-[13px] font-semibold flex-1">{t("aiSettings.answerLanguageTitle")}</div>
      </div>
      <div className="text-[11px] text-[var(--taomni-text-muted)] -mt-1">
        {t("aiSettings.answerLanguageDesc")}
      </div>
      <div className="space-y-1 pt-1">
        {GLOBAL_ANSWER_LANGUAGES.map((value) => (
          <label key={value} className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="editor-ai-answer-language"
              value={value}
              checked={current === value}
              onChange={() => update(value)}
              className="mt-0.5 accent-[var(--taomni-accent)]"
            />
            <div>
              <div className="text-[12px]">{LABELS[value]}</div>
              <div className="text-[10px] text-[var(--taomni-text-muted)]">{DESCRIPTIONS[value]}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
