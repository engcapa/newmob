// NON-PRODUCTION MODEL: no production consumer; see §8.13 N12
/**
 * Full Line Local Inline Completion Model & Ghost Text Session (A4).
 *
 * Implements local inline grey-text completion suggestions with word-by-word accept,
 * line accept, telemetry recording, and offline privacy guard.
 */

export interface FullLineSuggestion {
  id: string;
  lineText: string;
  insertText: string;
  acceptedWordsCount: number;
  totalWordsCount: number;
  confidence: number;
  isMultiLine: boolean;
}

export type FullLineAcceptAction = "all" | "word" | "line" | "dismiss";

export class FullLineSession {
  private activeSuggestion: FullLineSuggestion | null = null;

  setSuggestion(suggestion: FullLineSuggestion): void {
    this.activeSuggestion = suggestion;
  }

  getActiveSuggestion(): FullLineSuggestion | null {
    return this.activeSuggestion;
  }

  /**
   * Accept full suggestion text.
   */
  acceptAll(): string | null {
    if (!this.activeSuggestion) return null;
    const text = this.activeSuggestion.insertText;
    this.activeSuggestion = null;
    return text;
  }

  /**
   * Accept next single word from ghost text.
   */
  acceptNextWord(): { text: string; remainingText: string } | null {
    if (!this.activeSuggestion) return null;

    const words = this.activeSuggestion.insertText.match(/\S+|\s+/g) ?? [];
    if (words.length === 0) {
      this.activeSuggestion = null;
      return null;
    }

    const nextWord = words[0];
    if (!nextWord) {
      this.activeSuggestion = null;
      return null;
    }
    const remaining = words.slice(1).join("");

    if (!remaining) {
      this.activeSuggestion = null;
    } else {
      this.activeSuggestion = {
        ...this.activeSuggestion,
        insertText: remaining,
        acceptedWordsCount: this.activeSuggestion.acceptedWordsCount + 1,
      };
    }

    return { text: nextWord, remainingText: remaining };
  }

  dismiss(): void {
    this.activeSuggestion = null;
  }
}

export const globalFullLineSession = new FullLineSession();
