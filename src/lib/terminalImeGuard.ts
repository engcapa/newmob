const IME_SUPPRESS_WINDOW_MS = 220;
const IME_FALLBACK_COMMIT_DELAY_MS = 24;

type TimerHandle = ReturnType<typeof window.setTimeout>;

interface TerminalImeInputGuardOptions {
  commit: (data: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class TerminalImeInputGuard {
  private composing = false;
  private latestCompositionText = "";
  private latestReliableText = "";
  private committedImeTail = "";
  private lastCommittedText = "";
  private suppressXtermImeUntil = -1;
  private commitHandled = false;
  private fallbackTimer: TimerHandle | null = null;
  private readonly commit: (data: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(options: TerminalImeInputGuardOptions) {
    this.commit = options.commit;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay) as unknown as TimerHandle);
    this.clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  }

  handleCompositionStart(): void {
    this.cancelFallbackTimer();
    this.composing = true;
    this.commitHandled = false;
    this.latestCompositionText = "";
    this.latestReliableText = "";
    this.suppressXtermImeUntil = Number.POSITIVE_INFINITY;
  }

  handleCompositionUpdate(data: string): void {
    this.composing = true;
    if (isTextPayload(data)) {
      this.latestCompositionText = data;
    }
  }

  handleBeforeInput(data: string | null, inputType: string): void {
    this.captureInputText(data, inputType);
  }

  handleInput(data: string | null, inputType: string): void {
    this.captureInputText(data, inputType);
    if (!this.composing && this.isInSuppressWindow()) {
      this.commitCandidate(data);
    }
  }

  handleCompositionEnd(data: string): void {
    this.prepareImplicitComposition(data);
    this.composing = false;
    this.suppressXtermImeUntil = this.now() + IME_SUPPRESS_WINDOW_MS;

    if (this.commitCandidate(data)) {
      return;
    }
    if (this.commitCandidate(this.latestReliableText)) {
      return;
    }

    this.cancelFallbackTimer();
    this.fallbackTimer = this.setTimer(() => {
      if (!this.commitCandidate(this.latestReliableText)) {
        this.commitCandidate(this.latestCompositionText);
      }
    }, IME_FALLBACK_COMMIT_DELAY_MS);
  }

  filterTerminalData(data: string): string | null {
    if (!data) return data;

    if (this.composing) {
      const controlInput = keepControlInput(data);
      return controlInput || null;
    }

    if (this.isInSuppressWindow() && hasPrintableText(data)) {
      const controlInput = keepControlInput(data);
      return controlInput || null;
    }

    return data;
  }

  shouldInterceptKeyboardEvent(event: KeyboardEvent): boolean {
    return this.composing || event.isComposing || event.keyCode === 229;
  }

  shouldSuppressTerminalData(data: string): boolean {
    return this.filterTerminalData(data) === null;
  }

  dispose(): void {
    this.cancelFallbackTimer();
  }

  private captureInputText(data: string | null, inputType: string): void {
    if (!data || !isTextPayload(data)) return;

    if (inputType === "insertText") {
      this.latestReliableText = data;
    } else if (inputType === "insertCompositionText") {
      this.latestCompositionText = data;
    }
  }

  private commitCandidate(data: string | null): boolean {
    if (this.commitHandled || !data || !isTextPayload(data)) {
      return false;
    }

    const commitText = stripAlreadyCommittedPrefix(data, this.committedImeTail);
    if (!commitText || !isTextPayload(commitText)) {
      return false;
    }

    this.commitHandled = true;
    this.cancelFallbackTimer();
    this.recordCommittedImeText(commitText);
    this.commit(commitText);
    return true;
  }

  private recordCommittedImeText(data: string): void {
    const text = extractImeText(data);
    this.lastCommittedText = text;
    this.committedImeTail = (this.committedImeTail + text).slice(-80);
  }

  private prepareImplicitComposition(data: string | null): void {
    if (this.composing || !this.commitHandled || !data || !isTextPayload(data)) {
      return;
    }

    if (this.now() > this.suppressXtermImeUntil || data !== this.lastCommittedText) {
      this.cancelFallbackTimer();
      this.commitHandled = false;
      this.latestCompositionText = "";
      this.latestReliableText = "";
    }
  }

  private isInSuppressWindow(): boolean {
    return this.now() <= this.suppressXtermImeUntil;
  }

  private cancelFallbackTimer(): void {
    if (!this.fallbackTimer) return;
    this.clearTimer(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}

export function shouldUseLinuxImeGuard(): boolean {
  if (typeof navigator === "undefined") return false;
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return value.includes("linux");
}

export function attachTerminalImeGuard(target: HTMLElement, guard: TerminalImeInputGuard): () => void {
  const onCompositionStart = (event: CompositionEvent) => {
    guard.handleCompositionStart();
    stopXtermImeEvent(event);
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    guard.handleCompositionUpdate(event.data);
    stopXtermImeEvent(event);
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    guard.handleCompositionEnd(event.data);
    stopXtermImeEvent(event);
  };
  const onBeforeInput = (event: InputEvent) => {
    guard.handleBeforeInput(event.data, event.inputType);
    if (event.isComposing || event.inputType === "insertCompositionText" || guard.shouldSuppressTerminalData(event.data ?? "")) {
      stopXtermImeEvent(event);
    }
  };
  const onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    guard.handleInput(inputEvent.data, inputEvent.inputType);
    if (inputEvent.isComposing || inputEvent.inputType === "insertCompositionText" || guard.shouldSuppressTerminalData(inputEvent.data ?? "")) {
      stopXtermImeEvent(event);
    }
  };
  const onKeyboard = (event: KeyboardEvent) => {
    if (guard.shouldInterceptKeyboardEvent(event)) {
      stopXtermImeEvent(event);
      event.preventDefault();
    }
  };

  target.addEventListener("compositionstart", onCompositionStart, true);
  target.addEventListener("compositionupdate", onCompositionUpdate, true);
  target.addEventListener("compositionend", onCompositionEnd, true);
  target.addEventListener("beforeinput", onBeforeInput, true);
  target.addEventListener("input", onInput, true);
  target.addEventListener("keydown", onKeyboard, true);
  target.addEventListener("keypress", onKeyboard, true);
  target.addEventListener("keyup", onKeyboard, true);

  return () => {
    target.removeEventListener("compositionstart", onCompositionStart, true);
    target.removeEventListener("compositionupdate", onCompositionUpdate, true);
    target.removeEventListener("compositionend", onCompositionEnd, true);
    target.removeEventListener("beforeinput", onBeforeInput, true);
    target.removeEventListener("input", onInput, true);
    target.removeEventListener("keydown", onKeyboard, true);
    target.removeEventListener("keypress", onKeyboard, true);
    target.removeEventListener("keyup", onKeyboard, true);
    guard.dispose();
  };
}

function stopXtermImeEvent(event: Event): void {
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function isTextPayload(data: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(data)) return false;
  return data.length > 0;
}

function hasPrintableText(data: string): boolean {
  return /[^\x00-\x1f\x7f]/.test(data);
}

function extractImeText(data: string): string {
  return data.replace(/[\x00-\x1f\x7f]/g, "");
}

function keepControlInput(data: string): string {
  return data.replace(/[^\x00-\x1f\x7f]/g, "");
}

function stripAlreadyCommittedPrefix(data: string, committedTail: string): string {
  if (!committedTail) return data;

  const text = extractImeText(data);
  let prefixLength = Math.min(text.length - 1, committedTail.length);
  while (prefixLength > 0) {
    const committedSuffix = committedTail.slice(-prefixLength);
    if (text.startsWith(committedSuffix) && text.length > prefixLength) {
      const strippedText = text.slice(prefixLength);
      return data.replace(text, strippedText);
    }

    const suffixIndex = text.indexOf(committedSuffix);
    if (suffixIndex > 0) {
      const preeditPrefix = text.slice(0, suffixIndex);
      const strippedText = text.slice(suffixIndex + prefixLength);
      if (strippedText.startsWith(preeditPrefix)) {
        return data.replace(text, strippedText);
      }
    }

    prefixLength--;
  }

  return data;
}
