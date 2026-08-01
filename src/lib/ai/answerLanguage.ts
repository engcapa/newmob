// Answer language for AI explanation features (editor selection actions,
// database statement explanations).
//
// Two levels, so the setting is worth changing once:
//   - a global default, in Settings → AI, stored here;
//   - a per-surface override (e.g. per code-workspace instance) that defaults
//     to `inherit` and therefore follows the global default until the user
//     deliberately pins that one surface to a language.
//
// `auto` is a distinct choice from `inherit`: it means "follow the app locale",
// which is itself a live value. A user who wants Chinese answers in an English
// UI needs an explicit `zh-CN`, and that is what the two-level model buys.
//
// localStorage-backed rather than part of the Rust-side `AiConfig`: this is a
// presentation preference for prompt wording, and the editor AI preferences it
// joins are already a localStorage family.

import { getLocale } from "../i18n";

/**
 * Answer-language preference.
 * - `inherit` — follow the global default (per-surface overrides only).
 * - `auto` — follow the app locale.
 */
export type AiAnswerLanguage = "inherit" | "auto" | "zh-CN" | "en";

/** What the prompt templates are actually keyed by. */
export type ResolvedAnswerLanguage = "zh-CN" | "en";

/** The global default cannot itself be `inherit` — there is nothing above it. */
export type GlobalAnswerLanguage = Exclude<AiAnswerLanguage, "inherit">;

/** Selectable values for a per-surface picker, in menu order. */
export const AI_ANSWER_LANGUAGES: AiAnswerLanguage[] = ["inherit", "auto", "zh-CN", "en"];

/** Selectable values for the global Settings picker, in menu order. */
export const GLOBAL_ANSWER_LANGUAGES: GlobalAnswerLanguage[] = ["auto", "zh-CN", "en"];

export const DEFAULT_GLOBAL_ANSWER_LANGUAGE: GlobalAnswerLanguage = "auto";

const GLOBAL_STORAGE_KEY = "taomni.ai.answerLanguage.v1";

function isGlobalAnswerLanguage(value: unknown): value is GlobalAnswerLanguage {
  return GLOBAL_ANSWER_LANGUAGES.includes(value as GlobalAnswerLanguage);
}

/** Normalize an arbitrary value to a per-surface preference. */
export function normalizeAnswerLanguage(value: unknown): AiAnswerLanguage {
  return AI_ANSWER_LANGUAGES.includes(value as AiAnswerLanguage)
    ? value as AiAnswerLanguage
    : "inherit";
}

/**
 * The global default. Falls back to `auto` for missing, corrupt, or
 * out-of-range values — a bad stored preference must never break a prompt.
 */
export function readGlobalAnswerLanguage(): GlobalAnswerLanguage {
  if (typeof window === "undefined") return DEFAULT_GLOBAL_ANSWER_LANGUAGE;
  try {
    const raw = window.localStorage.getItem(GLOBAL_STORAGE_KEY);
    return isGlobalAnswerLanguage(raw) ? raw : DEFAULT_GLOBAL_ANSWER_LANGUAGE;
  } catch {
    return DEFAULT_GLOBAL_ANSWER_LANGUAGE;
  }
}

export function writeGlobalAnswerLanguage(language: GlobalAnswerLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GLOBAL_STORAGE_KEY, language);
  } catch {
    // Ignore storage failures — the preference is a convenience, not state we
    // can block an AI request on.
  }
}

/**
 * Resolve a preference down to the language a prompt template is keyed by.
 * `inherit` consults the global default; `auto` (at either level) follows the
 * app locale, with English as the fallback for every non-Chinese locale.
 */
export function resolveAnswerLanguage(preference: AiAnswerLanguage): ResolvedAnswerLanguage {
  const effective = preference === "inherit" ? readGlobalAnswerLanguage() : preference;
  if (effective === "zh-CN" || effective === "en") return effective;
  return getLocale() === "zh-CN" ? "zh-CN" : "en";
}

/** Next value in the per-surface cycle, for the keyboard/cycle-button path. */
export function nextAnswerLanguage(current: AiAnswerLanguage): AiAnswerLanguage {
  const index = AI_ANSWER_LANGUAGES.indexOf(current);
  return AI_ANSWER_LANGUAGES[(index + 1) % AI_ANSWER_LANGUAGES.length];
}

/** i18n key for a preference's short badge label. */
export function answerLanguageLabelKey(language: AiAnswerLanguage): string {
  if (language === "inherit") return "codeWorkspaceAi.answerLanguageInherit";
  if (language === "zh-CN") return "codeWorkspaceAi.answerLanguageZh";
  if (language === "en") return "codeWorkspaceAi.answerLanguageEn";
  return "codeWorkspaceAi.answerLanguageAuto";
}
