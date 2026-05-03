import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Terminal, type IBufferLine } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  loadGlobalTerminalProfile,
  parseSessionOptions,
  resolveTerminalTheme,
  saveGlobalTerminalProfile,
  type TerminalProfile,
  type TerminalSyntaxMode,
} from "../../lib/terminalProfile";
import {
  getSessionNetworkSettings,
  toNetworkSettingsPayload,
} from "../../lib/networkSettings";
import { TERMINAL_THEME_DEFINITIONS, resolveThemeId } from "../../lib/themes";
import {
  findFontName,
  getPrimaryFontName,
  makeTerminalFontFamily,
  SAFE_TERMINAL_FONT_FALLBACKS,
  useSystemFonts,
} from "../../lib/systemFonts";
import {
  attachTerminalImeGuard,
  shouldUseLinuxImeGuard,
  TerminalImeInputGuard,
} from "../../lib/terminalImeGuard";
import {
  createLocalTerminal,
  createSshTerminal,
  writeTerminal,
  resizeTerminal,
  sendTerminalSignal,
  closeTerminal,
  listenTerminalOutput,
  listenTerminalExit,
  listenTerminalForwardError,
  encodeBase64,
  decodeBase64,
} from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

export interface SshConnectInfo {
  /** Persisted session config id, if this terminal was opened from a
   *  saved session. Used so the SessionEditor can subscribe to runtime
   *  forward errors for the session it is editing. */
  sessionId?: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  optionsJson?: string;
  /** When false, the OSC 7 PROMPT_COMMAND/precmd snippet is NOT injected.
   *  Default is undefined → treated as enabled. */
  osc7AutoInject?: boolean;
}

interface TerminalPanelProps {
  tabId?: string;
  tabTitle?: string;
  theme?: string;
  ssh?: SshConnectInfo;
  localShell?: {
    id: string;
    name: string;
  };
  terminalProfile?: TerminalProfile;
  visible?: boolean;
  onCwdChange?: (cwd: string) => void;
}

const DEFAULT_FONT_SIZE = 14;

interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

interface KeywordHighlight extends SearchMatch {
  kind: "error" | "warning" | "success";
}

interface TerminalEventLogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
}

export function TerminalPanel({
  tabId,
  tabTitle = "Terminal",
  theme = "classic",
  ssh,
  localShell,
  terminalProfile,
  visible = true,
  onCwdChange,
}: TerminalPanelProps) {
  const cwdCallbackRef = useRef<typeof onCwdChange>(onCwdChange);
  useEffect(() => {
    cwdCallbackRef.current = onCwdChange;
  }, [onCwdChange]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const readOnlyRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fallbackSearchRef = useRef<{ query: string; index: number }>({ query: "", index: -1 });
  const contextMenu = useContextMenu();
  const fontState = useSystemFonts();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const initialProfileRef = useRef<TerminalProfile | null>(null);
  if (!initialProfileRef.current) {
    initialProfileRef.current = terminalProfile ?? loadGlobalTerminalProfile();
  }
  const initialProfile = initialProfileRef.current;

  const [fontFamily, setFontFamily] = useState(initialProfile.fontFamily);
  const [fontSize, setFontSize] = useState(initialProfile.fontSize);
  const [fontLigatures, setFontLigatures] = useState(initialProfile.fontLigatures);
  const [showScrollbar, setShowScrollbar] = useState(initialProfile.showScrollbar);
  const [readOnly, setReadOnly] = useState(initialProfile.readOnly);
  const [themeName, setThemeName] = useState(initialProfile.theme || theme);
  const [cursorStyle] = useState(initialProfile.cursorStyle);
  const [cursorBlink] = useState(initialProfile.cursorBlink);
  const [scrollback] = useState(initialProfile.scrollback);
  const [syntaxMode, setSyntaxMode] = useState<TerminalSyntaxMode>(initialProfile.syntaxMode);
  const [loggingActive, setLoggingActive] = useState(initialProfile.loggingEnabled);
  const [fullscreen, setFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [eventLog, setEventLog] = useState<TerminalEventLogEntry[]>([]);
  const [macroRecording, setMacroRecording] = useState(false);
  const outputLogRef = useRef("");
  const loggingActiveRef = useRef(loggingActive);
  const macroRecordingRef = useRef(macroRecording);
  const macroBufferRef = useRef("");
  const lastMacroRef = useRef("");
  const macroPlaybackRef = useRef(false);
  const eventIdRef = useRef(0);
  const imeGuardRef = useRef<TerminalImeInputGuard | null>(null);
  const quickFontOptions = useMemo(() => {
    const available = fontState.fonts;
    const preferred = SAFE_TERMINAL_FONT_FALLBACKS
      .map((font) => findFontName(available, font))
      .filter((font): font is string => !!font);
    return preferred.length > 0 ? preferred : available.slice(0, 8);
  }, [fontState.fonts]);

  const fitVisibleTerminal = useCallback(() => {
    const el = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !term || !fitAddon || el.clientWidth === 0 || el.clientHeight === 0) {
      return;
    }

    try {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
      const sid = sessionIdRef.current;
      if (sid) {
        resizeTerminal(sid, term.cols, term.rows).catch(() => {});
      }
    } catch {
      // Hidden tabs can briefly report invalid dimensions while switching.
    }
  }, []);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const appendEvent = useCallback((type: string, detail: string) => {
    const entry: TerminalEventLogEntry = {
      id: ++eventIdRef.current,
      time: new Date().toLocaleTimeString(),
      type,
      detail,
    };
    setEventLog((items) => [...items.slice(-199), entry]);
  }, []);

  const currentProfile = useCallback((): TerminalProfile => ({
    ...initialProfile,
    fontFamily,
    fontSize,
    fontLigatures,
    theme: themeName,
    scrollback,
    cursorStyle,
    cursorBlink,
    showScrollbar,
    readOnly,
    syntaxMode,
    loggingEnabled: loggingActive,
  }), [
    cursorBlink,
    cursorStyle,
    fontFamily,
    fontLigatures,
    fontSize,
    initialProfile,
    loggingActive,
    readOnly,
    scrollback,
    showScrollbar,
    syntaxMode,
    themeName,
  ]);

  const sendTerminalInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current) return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBase64(data)).catch(console.error);
  }, []);

  const writeInput = sendTerminalInput;

  const writeXtermInput = useCallback((data: string) => {
    const filtered = imeGuardRef.current?.filterTerminalData(data) ?? data;
    if (filtered === null) {
      return;
    }
    sendTerminalInput(filtered);
  }, [sendTerminalInput]);

  const writeBinaryInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current) return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBinaryStringBase64(data)).catch(console.error);
  }, []);

  const writeClipboardText = useCallback(async (text: string, successMessage: string) => {
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopyText(text);
      }
      setStatusMessage(successMessage);
    } catch (err) {
      if (fallbackCopyText(text)) {
        setStatusMessage(successMessage);
      } else {
        setStatusMessage(err instanceof Error ? err.message : "Clipboard copy failed");
      }
    }
  }, [setStatusMessage]);

  const copySelection = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(term.getSelection(), "Copied selection");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(getBufferText(term), "Copied terminal buffer");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyFormattedSelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = term.getSelection();
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }

    const resolvedTheme = resolveTerminalTheme(themeName);
    const html = `<pre style="margin:0;font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px;background:${resolvedTheme.background ?? "#1d1f21"};color:${resolvedTheme.foreground ?? "#eaeaea"};white-space:pre-wrap;">${escapeHtml(text)}</pre>`;

    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        setStatusMessage("Copied formatted selection");
      } else {
        await writeClipboardText(text, "Copied selection");
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Formatted copy failed");
    } finally {
      focusTerminal();
    }
  }, [focusTerminal, fontFamily, fontSize, setStatusMessage, themeName, writeClipboardText]);

  const pasteFromClipboard = useCallback(async () => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    try {
      const text = navigator.clipboard?.readText
        ? await navigator.clipboard.readText()
        : window.prompt("Paste text") ?? "";
      if (!text) return;
      if (
        initialProfile.multilinePasteConfirm &&
        /\r?\n/.test(text) &&
        !window.confirm(`Paste ${text.split(/\r?\n/).length} lines into this terminal?`)
      ) {
        return;
      }
      writeInput(normalizePasteText(text));
      focusTerminal();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
    }
  }, [focusTerminal, initialProfile.multilinePasteConfirm, setStatusMessage, writeInput]);

  const saveBufferToFile = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    downloadTextFile(
      `${safeFilePart(tabTitle)}-${timestampFilePart()}.txt`,
      getBufferText(term),
      "text/plain",
    );
    appendEvent("export", "Saved terminal buffer to file");
    setStatusMessage("Saved terminal buffer");
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, tabTitle]);

  const flushRecordedOutput = useCallback((reason: string) => {
    if (!outputLogRef.current) {
      setStatusMessage("No recorded output to save");
      return;
    }
    downloadTextFile(
      `${safeFilePart(tabTitle)}-recording-${timestampFilePart()}.txt`,
      outputLogRef.current,
      "text/plain",
    );
    appendEvent("log", reason);
    outputLogRef.current = "";
    setStatusMessage("Saved terminal recording");
  }, [appendEvent, setStatusMessage, tabTitle]);

  const toggleOutputRecording = useCallback(() => {
    setLoggingActive((active) => {
      if (active) {
        flushRecordedOutput("Stopped output recording and saved file");
        return false;
      }
      outputLogRef.current = "";
      appendEvent("log", "Started output recording");
      setStatusMessage("Recording terminal output");
      return true;
    });
    focusTerminal();
  }, [appendEvent, flushRecordedOutput, focusTerminal, setStatusMessage]);

  const toggleMacroRecording = useCallback(() => {
    setMacroRecording((active) => {
      if (active) {
        lastMacroRef.current = macroBufferRef.current;
        appendEvent("macro", `Recorded ${lastMacroRef.current.length} input character${lastMacroRef.current.length === 1 ? "" : "s"}`);
        setStatusMessage(lastMacroRef.current ? "Macro recorded" : "Macro recording was empty");
        return false;
      }
      macroBufferRef.current = "";
      appendEvent("macro", "Started macro recording");
      setStatusMessage("Recording terminal macro");
      return true;
    });
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage]);

  const executeMacro = useCallback(() => {
    const macro = lastMacroRef.current;
    if (!macro) {
      setStatusMessage("No macro recorded");
      return;
    }
    macroPlaybackRef.current = true;
    writeInput(macro);
    macroPlaybackRef.current = false;
    appendEvent("macro", `Executed macro (${macro.length} input character${macro.length === 1 ? "" : "s"})`);
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, writeInput]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchStatus("");
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchStatus("");
    setSearchMatches([]);
    setActiveSearchIndex(-1);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    focusTerminal();
  }, [focusTerminal]);

  const runSearch = useCallback((direction: "next" | "previous" = "next") => {
    const terminal = termRef.current;
    const term = (searchInputRef.current?.value ?? searchValue).trim();
    if (!terminal || !term) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("");
      return;
    }

    searchAddonRef.current?.clearDecorations();
    const result = findAndSelectBufferText(
      terminal,
      term,
      direction,
      fallbackSearchRef,
    );
    if (result) {
      setSearchMatches(result.matches);
      setActiveSearchIndex(result.index);
      setSearchStatus(`Match ${result.index + 1}/${result.total}`);
    } else {
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("No matches");
    }
  }, [searchValue]);

  const renameTerminal = useCallback(() => {
    if (!tabId) return;
    const nextTitle = window.prompt("Set terminal title", tabTitle);
    if (!nextTitle?.trim()) return;
    updateTabTitle(tabId, nextTitle.trim());
    focusTerminal();
  }, [focusTerminal, tabId, tabTitle, updateTabTitle]);

  const resetOutput = useCallback(() => {
    termRef.current?.reset();
    fitVisibleTerminal();
    focusTerminal();
  }, [fitVisibleTerminal, focusTerminal]);

  const clearScrollback = useCallback(() => {
    termRef.current?.clear();
    focusTerminal();
  }, [focusTerminal]);

  const increaseFontSize = useCallback(() => {
    setFontSize((size) => Math.min(size + 1, 32));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setFontSize((size) => Math.max(size - 1, 8));
  }, []);

  const resetFontSize = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
  }, []);

  const setSyntaxModeAndFocus = useCallback((mode: TerminalSyntaxMode) => {
    setSyntaxMode(mode);
    focusTerminal();
  }, [focusTerminal]);

  const sendSpecialSignal = useCallback((signal: string, fallback?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendTerminalSignal(sid, signal)
      .then(() => {
        appendEvent("signal", `Sent ${signal}`);
        setStatusMessage(`Sent ${signal}`);
      })
      .catch((err) => {
        if (fallback) {
          writeInput(fallback);
          appendEvent("signal", `Sent ${signal} fallback control character`);
          setStatusMessage(`Sent ${signal} fallback`);
        } else {
          appendEvent("error", `${signal} failed: ${String(err)}`);
          setStatusMessage(err instanceof Error ? err.message : String(err));
        }
      });
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, writeInput]);

  const handleShortcutKey = useCallback((event: KeyboardEvent): boolean => {
    if (event.key === "F11") {
      event.preventDefault();
      setFullscreen((v) => !v);
      return false;
    }
    if (event.shiftKey && event.key === "Insert") {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearch();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveBufferToFile();
      return false;
    }
    if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      increaseFontSize();
      return false;
    }
    if (event.ctrlKey && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      decreaseFontSize();
      return false;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      resetFontSize();
      return false;
    }
    if (event.ctrlKey && event.code === "Space") {
      event.preventDefault();
      executeMacro();
      return false;
    }
    if (searchOpen && event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return false;
    }
    return true;
  }, [
    closeSearch,
    decreaseFontSize,
    executeMacro,
    increaseFontSize,
    openSearch,
    pasteFromClipboard,
    resetFontSize,
    saveBufferToFile,
    searchOpen,
  ]);

  const buildContextMenu = useCallback((): MenuItem[] => {
    const hasSelection = termRef.current?.hasSelection() ?? false;

    return [
      { label: "Copy", onClick: copySelection, disabled: !hasSelection },
      { label: "Copy All", onClick: copyAll },
      { label: "Copy formatted text (HTML/RTF)", onClick: () => void copyFormattedSelection(), disabled: !hasSelection },
      { label: "Paste", shortcut: "Shift+Insert", onClick: () => void pasteFromClipboard(), disabled: readOnly },
      { label: "Find", shortcut: "Ctrl+Shift+F", onClick: openSearch },
      { label: "", separator: true },
      {
        label: "Font settings",
        children: [
          ...quickFontOptions.map((font) => ({
            label: `Use font "${font}"`,
            checked: getPrimaryFontName(fontFamily).toLowerCase() === font.toLowerCase(),
            onClick: () => setFontFamily(makeTerminalFontFamily(font)),
          })),
          ...(quickFontOptions.length === 0 ? [{ label: "Loading fonts...", disabled: true }] : []),
          { label: "Display font ligatures", checked: fontLigatures, onClick: () => setFontLigatures((v) => !v) },
          { label: "", separator: true },
          { label: "Increase font size", shortcut: "Ctrl++ / Ctrl+WheelUp", onClick: increaseFontSize },
          { label: "Decrease font size", shortcut: "Ctrl+- / Ctrl+WheelDown", onClick: decreaseFontSize },
          { label: "Reset font size to default", shortcut: "Ctrl+0", onClick: resetFontSize },
        ],
      },
      {
        label: "Theme",
        children: TERMINAL_THEME_DEFINITIONS.map((definition) => ({
          label: definition.name,
          checked: resolveThemeId(themeName) === definition.id,
          onClick: () => setThemeName(definition.id),
        })),
      },
      {
        label: "Terminal display",
        children: [
          { label: "Reset terminal output", onClick: resetOutput },
          { label: "Clear terminal scrollback", onClick: clearScrollback },
          { label: "Set terminal title", onClick: renameTerminal, disabled: !tabId },
          { label: "Toggle terminal scrollbar", checked: showScrollbar, onClick: () => setShowScrollbar((v) => !v) },
          { label: "Fullscreen terminal", shortcut: "F11", checked: fullscreen, onClick: () => setFullscreen((v) => !v) },
          { label: "Read-only terminal", checked: readOnly, onClick: () => setReadOnly((v) => !v) },
        ],
      },
      {
        label: "Syntax highlighting",
        children: [
          { label: "Default", checked: syntaxMode === "default", onClick: () => setSyntaxModeAndFocus("default") },
          { label: "Error/Warning/Success keywords", checked: syntaxMode === "keywords", onClick: () => setSyntaxModeAndFocus("keywords") },
          { label: "Unix shell script", disabled: true },
          { label: "Cisco (network configuration)", disabled: true },
          { label: "Perl syntax", disabled: true },
          { label: "SQL syntax", disabled: true },
        ],
      },
      { label: "", separator: true },
      { label: "Execute macro", shortcut: "Ctrl+Space", onClick: executeMacro, disabled: !lastMacroRef.current },
      { label: macroRecording ? "Stop macro recording" : "Record new macro", checked: macroRecording, onClick: toggleMacroRecording },
      { label: loggingActive ? "Stop recording terminal output" : "Record terminal output to file", checked: loggingActive, onClick: toggleOutputRecording },
      { label: "Save to file", shortcut: "Ctrl+Shift+S", onClick: saveBufferToFile },
      { label: "Print", shortcut: "Ctrl+Shift+P", disabled: true },
      { label: "", separator: true },
      { label: "Receive file using Z-modem", disabled: true },
      { label: "Send file using Z-modem", disabled: true },
      { label: "", separator: true },
      { label: "Change current terminal settings...", disabled: true },
      {
        label: "Special Command",
        children: [
          { label: "Break", disabled: true },
          { label: "SIGINT (Interrupt)", onClick: () => sendSpecialSignal("SIGINT", "\x03") },
          { label: "SIGTERM (Terminate)", onClick: () => sendSpecialSignal("SIGTERM") },
          { label: "SIGKILL (Kill)", onClick: () => sendSpecialSignal("SIGKILL") },
          { label: "SIGQUIT (Quit)", onClick: () => sendSpecialSignal("SIGQUIT", "\x1c") },
          { label: "SIGHUP (Hangup)", onClick: () => sendSpecialSignal("SIGHUP") },
          { label: "More signals", disabled: true },
          { label: "", separator: true },
          { label: "IGNORE message", disabled: true },
        ],
      },
      { label: "Event Log", onClick: () => setEventLogOpen(true) },
    ];
  }, [
    clearScrollback,
    copyAll,
    copyFormattedSelection,
    copySelection,
    decreaseFontSize,
    executeMacro,
    fontFamily,
    fontLigatures,
    fullscreen,
    increaseFontSize,
    openSearch,
    pasteFromClipboard,
    quickFontOptions,
    readOnly,
    renameTerminal,
    resetFontSize,
    resetOutput,
    saveBufferToFile,
    showScrollbar,
    syntaxMode,
    setSyntaxModeAndFocus,
    themeName,
    sendSpecialSignal,
    tabId,
    toggleMacroRecording,
    toggleOutputRecording,
    loggingActive,
    macroRecording,
  ]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    loggingActiveRef.current = loggingActive;
  }, [loggingActive]);

  useEffect(() => {
    macroRecordingRef.current = macroRecording;
  }, [macroRecording]);

  useEffect(() => {
    if (terminalProfile) return;
    saveGlobalTerminalProfile(currentProfile());
  }, [currentProfile, terminalProfile]);

  // Initialize once for the lifetime of this tab. Visibility changes must not
  // dispose the terminal, otherwise PTY/SSH sessions reconnect on tab switch.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || initializedRef.current) return;

    initializedRef.current = true;

    let destroyed = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenForwardError: UnlistenFn | null = null;
    let detachImeGuard: (() => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout>;

    const term = new Terminal({
      theme: resolveTerminalTheme(themeName),
      fontFamily,
      fontSize,
      cursorBlink,
      cursorStyle,
      scrollback,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    // OSC 7 — host writes its current working directory as `file://host/path`
    // so the attached SFTP browser can follow `cd` automatically.
    try {
      term.parser.registerOscHandler(7, (data) => {
        const cwd = parseOsc7(data);
        if (cwd) {
          cwdCallbackRef.current?.(cwd);
        }
        return true;
      });
    } catch {
      /* parser API absent in some xterm builds */
    }

    if (shouldUseLinuxImeGuard()) {
      // Linux WebKitGTK can forward IME preedit text through xterm before the final commit.
      const guard = new TerminalImeInputGuard({ commit: sendTerminalInput });
      imeGuardRef.current = guard;
      detachImeGuard = attachTerminalImeGuard(el, guard);
    }

    try {
      term.loadAddon(new WebglAddon());
    } catch { /* WebGL not available */ }

    fitVisibleTerminal();

    term.onData(writeXtermInput);
    term.onBinary(writeBinaryInput);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return handleShortcutKey(event);
    });
    const scrollDisposable = term.onScroll(() => setViewportVersion((v) => v + 1));
    const renderDisposable = term.onRender(() => setViewportVersion((v) => v + 1));
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      setViewportVersion((v) => v + 1);
      appendEvent("resize", `${cols}x${rows}`);
    });

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitVisibleTerminal();
      }, 100);
    });
    observer.observe(el);

    const { cols, rows } = term;

    const connectPromise = ssh
      ? createSshTerminal(
          ssh.host,
          ssh.port,
          ssh.username,
          ssh.authMethod,
          ssh.authData,
          cols,
          rows,
          (() => {
            const ns = getSessionNetworkSettings(ssh.optionsJson);
            return JSON.stringify(toNetworkSettingsPayload(ns));
          })(),
        )
      : createLocalTerminal(cols, rows, localShell?.id);

    if (ssh) {
      appendEvent("connection", `Connecting to ${ssh.username}@${ssh.host}:${ssh.port}`);
      appendEvent("auth", `Using ${ssh.authMethod} authentication`);
      term.write(`\x1b[33mConnecting to ${ssh.username}@${ssh.host}:${ssh.port}...\x1b[0m\r\n`);
    } else {
      appendEvent("connection", `Starting ${localShell?.name ?? "local terminal"}`);
    }

    connectPromise
      .then(async (sid) => {
        if (destroyed) {
          closeTerminal(sid).catch(() => {});
          return;
        }
        sessionIdRef.current = sid;
        appendEvent("connection", `Connected (${sid})`);
        if (ssh) {
          term.write(formatSshInfoBanner(ssh));
        }

        unlistenOutput = await listenTerminalOutput(sid, (b64) => {
          const output = decodeBase64(b64);
          if (loggingActiveRef.current) {
            outputLogRef.current += new TextDecoder().decode(output);
          }
          term.write(output);
        });

        if (ssh && ssh.osc7AutoInject !== false) {
          // Best-effort: teach the remote shell to emit OSC 7 on every
          // prompt so the SFTP browser can follow the cwd.  We send the
          // snippet a short while after connection so the shell PS1 has
          // already drawn at least once and the user typically still
          // sees a clean prompt afterwards.
          window.setTimeout(() => {
            if (destroyed || sessionIdRef.current !== sid) return;
            const snippet =
              " __newmob_osc7(){ printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; };" +
              " case \"${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}\" in" +
              " bash) PROMPT_COMMAND=\"__newmob_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;;" +
              " zsh) precmd_functions+=(__newmob_osc7) ;;" +
              " esac; __newmob_osc7\r";
            writeTerminal(sid, encodeBase64(snippet)).catch(() => {});
          }, 1200);
        }

        unlistenExit = await listenTerminalExit(sid, () => {
          appendEvent("disconnect", "Terminal session ended");
          if (loggingActiveRef.current && outputLogRef.current) {
            flushRecordedOutput("Session ended; saved recorded output");
          }
          term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
        });

        // Surface per-row local-forward errors (parse, bind, accept,
        // direct-tcpip open) in the same event log the user already sees
        // for connection / auth / disconnect events. Also re-broadcast
        // as a window-level CustomEvent keyed by the persisted session
        // config id so an open SessionEditor can show the failure
        // inline next to the offending forward row.
        unlistenForwardError = await listenTerminalForwardError(sid, (err) => {
          appendEvent(
            "error",
            `Local forward ${err.local} → ${err.remote}: ${err.message}`,
          );
          if (ssh?.sessionId) {
            window.dispatchEvent(
              new CustomEvent("newmob:forward-error", {
                detail: {
                  sessionConfigId: ssh.sessionId,
                  local: err.local,
                  remote: err.remote,
                  message: err.message,
                },
              }),
            );
          }
        });
      })
      .catch((err) => {
        console.error("Failed to create terminal:", err);
        appendEvent("error", `Connection failed: ${String(err)}`);
        term.write(`\x1b[31mConnection failed: ${err}\x1b[0m\r\n`);
      });

    return () => {
      destroyed = true;
      observer.disconnect();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      clearTimeout(resizeTimer);
      unlistenOutput?.();
      unlistenExit?.();
      unlistenForwardError?.();
      detachImeGuard?.();
      if (loggingActiveRef.current && outputLogRef.current) {
        flushRecordedOutput("Terminal closed; saved recorded output");
      }
      if (sessionIdRef.current) closeTerminal(sessionIdRef.current).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      sessionIdRef.current = null;
      imeGuardRef.current = null;
      initializedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options = {
      fontFamily,
      fontSize,
      theme: resolveTerminalTheme(themeName),
      cursorBlink,
      cursorStyle,
      scrollback,
    };
    window.setTimeout(() => requestAnimationFrame(fitVisibleTerminal), 0);
  }, [cursorBlink, cursorStyle, fitVisibleTerminal, fontFamily, fontSize, scrollback, themeName]);

  // When a hidden tab becomes visible again, only re-measure and repaint xterm.
  useEffect(() => {
    if (!visible) return;

    const timer = window.setTimeout(() => {
      requestAnimationFrame(fitVisibleTerminal);
    }, 50);

    return () => window.clearTimeout(timer);
  }, [fitVisibleTerminal, fullscreen, showScrollbar, visible]);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (handleShortcutKey(event) === false) {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleShortcutKey, visible]);

  useEffect(() => {
    if (!visible) return;

    const el = panelRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, visible]);

  useEffect(() => {
    if (!searchOpen) return;

    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!searchValue.trim()) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      termRef.current?.clearSelection();
      setSearchStatus("");
      return;
    }

    const timer = window.setTimeout(() => runSearch("next"), 120);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchOpen, searchValue]);

  const searchHighlights = useMemo(
    () => getVisibleSearchHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      searchMatches,
      activeSearchIndex,
    ),
    [activeSearchIndex, fontSize, fullscreen, searchMatches, showScrollbar, viewportVersion],
  );

  const keywordHighlights = useMemo(
    () => getVisibleKeywordHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      syntaxMode,
    ),
    [fontSize, fullscreen, showScrollbar, syntaxMode, viewportVersion],
  );

  const panelClasses = [
    "relative w-full h-full",
    fullscreen ? "fixed inset-0 z-[9000]" : "",
    showScrollbar ? "" : "terminal-hide-scrollbar",
    fontLigatures ? "terminal-font-ligatures" : "terminal-no-font-ligatures",
  ].filter(Boolean).join(" ");
  const resolvedTheme = resolveTerminalTheme(themeName);

  return (
    <div
      ref={panelRef}
      data-testid="terminal-pane"
      className={panelClasses}
      style={{ background: resolvedTheme.background ?? "#1d1f21" }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (event.deltaY < 0) {
          increaseFontSize();
        } else if (event.deltaY > 0) {
          decreaseFontSize();
        }
      }}
      onContextMenu={(event) => contextMenu.show(event, buildContextMenu())}
    >
      <div ref={containerRef} className="w-full h-full" />

      {keywordHighlights.length > 0 && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          {keywordHighlights.map((highlight) => (
            <div
              key={`kw-${highlight.row}-${highlight.col}-${highlight.kind}`}
              className={`terminal-keyword-hit terminal-keyword-${highlight.kind}`}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {searchHighlights.length > 0 && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          {searchHighlights.map((highlight) => (
            <div
              key={`${highlight.row}-${highlight.col}-${highlight.active ? "active" : "match"}`}
              className={highlight.active ? "terminal-search-hit terminal-search-hit-active" : "terminal-search-hit"}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {readOnly && (
        <div className="absolute right-3 bottom-3 z-40 px-2 py-1 rounded border bg-white/90 text-[11px] text-slate-700 shadow-sm pointer-events-none">
          Read-only
        </div>
      )}

      {searchOpen && (
        <div
          className="absolute right-3 top-3 z-50 flex items-center gap-1 rounded border border-slate-400 bg-white p-1 shadow-lg text-[12px]"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            className="moba-input h-7 w-56"
            value={searchValue}
            placeholder="Find"
            onChange={(event) => {
              const next = event.target.value;
              setSearchValue(next);
              fallbackSearchRef.current = { query: next.trim(), index: -1 };
              setSearchStatus("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
              }
            }}
          />
          <button className="moba-btn h-7 px-2" type="button" onClick={() => runSearch("previous")}>
            Prev
          </button>
          <button className="moba-btn h-7 px-2" type="button" onClick={() => runSearch("next")}>
            Next
          </button>
          <button className="moba-btn h-7 px-2" type="button" onClick={closeSearch}>
            Close
          </button>
          {searchStatus && <span className="px-1 text-[11px] text-[#b22222]">{searchStatus}</span>}
        </div>
      )}

      {eventLogOpen && (
        <div
          className="absolute right-4 bottom-4 z-50 w-[520px] max-w-[calc(100%-2rem)] max-h-[360px] rounded border border-slate-500 bg-white shadow-xl text-[12px] overflow-hidden"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div className="h-8 flex items-center px-3 border-b bg-slate-100">
            <span className="font-semibold">Event Log</span>
            <button className="moba-btn ml-auto h-6 px-2" type="button" onClick={() => setEventLogOpen(false)}>
              Close
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {eventLog.length === 0 ? (
              <div className="p-3 text-slate-500">No terminal events yet.</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {eventLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="w-20 px-2 py-1 text-slate-500 moba-mono">{entry.time}</td>
                      <td className="w-24 px-2 py-1 font-semibold">{entry.type}</td>
                      <td className="px-2 py-1">{entry.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {contextMenu.render}
    </div>
  );
}

function formatSshInfoBanner(ssh: SshConnectInfo): string {
  const options = parseSessionOptions(ssh.optionsJson);
  const compression = options.compression === true;
  const x11 = options.x11 !== false;
  const sshBrowser = typeof options.sshBrowser === "string" ? options.sshBrowser : "SFTP protocol (recommended)";
  const sshBrowserEnabled = sshBrowser !== "Disabled";
  const rows = [
    "NewMob SSH terminal",
    "SSH session to " + ssh.username + "@" + ssh.host,
    "Direct SSH      : " + checkMark(true),
    "SSH compression : " + checkMark(compression),
    "SSH-browser     : " + checkMark(sshBrowserEnabled) + (sshBrowserEnabled ? "  " + sshBrowser : ""),
    "X11-forwarding  : " + checkMark(x11) + (x11 ? "  (remote display is forwarded through SSH)" : ""),
    "",
    "For more info, edit SSH session advanced settings.",
  ];
  const width = Math.max(68, ...rows.map((row) => row.length + 4));
  const border = "+" + "-".repeat(width - 2) + "+";
  const body = rows.map((row) => "| " + row.padEnd(width - 4) + " |");
  return "\r\n" + [border, ...body, border].join("\r\n") + "\r\n";
}

function checkMark(enabled: boolean): string {
  return enabled ? "✓" : "✗";
}

function getBufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

function findAndSelectBufferText(
  term: Terminal,
  query: string,
  direction: "next" | "previous",
  searchRef: MutableRefObject<{ query: string; index: number }>,
): { index: number; total: number; matches: SearchMatch[] } | null {
  const matches = collectBufferMatches(term, query);
  if (matches.length === 0) {
    return null;
  }

  const sameQuery = searchRef.current.query === query;
  let nextIndex = sameQuery ? searchRef.current.index : -1;

  if (nextIndex < 0) {
    nextIndex = firstVisibleMatchIndex(term, matches, direction);
  } else {
    nextIndex = direction === "next"
      ? (nextIndex + 1) % matches.length
      : (nextIndex - 1 + matches.length) % matches.length;
  }

  const match = matches[nextIndex];
  term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 2)));
  term.select(match.col, match.row, match.length);
  term.refresh(0, term.rows - 1);
  searchRef.current = { query, index: nextIndex };
  return { index: nextIndex, total: matches.length, matches };
}

function collectBufferMatches(term: Terminal, query: string): SearchMatch[] {
  const buffer = term.buffer.active;
  const matches: SearchMatch[] = [];
  const needle = query.toLocaleLowerCase();

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    const haystack = text.toLocaleLowerCase();
    let stringIndex = haystack.indexOf(needle);
    while (stringIndex !== -1) {
      const startCell = stringIndexToCell[stringIndex];
      const lastCell = stringIndexToCell[stringIndex + Math.max(needle.length - 1, 0)];
      if (typeof startCell === "number" && typeof lastCell === "number") {
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
        });
      }
      stringIndex = haystack.indexOf(needle, stringIndex + Math.max(needle.length, 1));
    }
  }

  return matches;
}

function lineToSearchText(line: IBufferLine): { text: string; stringIndexToCell: number[] } {
  let text = "";
  const stringIndexToCell: number[] = [];

  for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || " ";
    for (let offset = 0; offset < chars.length; offset++) {
      stringIndexToCell[text.length + offset] = cellIndex;
    }
    text += chars;
  }

  const trimmedLength = text.trimEnd().length;
  return {
    text: text.slice(0, trimmedLength),
    stringIndexToCell: stringIndexToCell.slice(0, trimmedLength),
  };
}

function getVisibleSearchHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  matches: SearchMatch[],
  activeIndex: number,
) {
  if (!term || !panel || !container || matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .map((match, index) => ({ ...match, index }))
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      row: match.row,
      col: match.col,
      active: match.index === activeIndex,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}

function getVisibleKeywordHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  mode: TerminalSyntaxMode,
) {
  if (mode !== "keywords" || !term || !panel || !container) return [];
  const matches = collectKeywordMatches(term);
  if (matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      ...match,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}

function collectKeywordMatches(term: Terminal): KeywordHighlight[] {
  const rules: Array<{ kind: KeywordHighlight["kind"]; pattern: RegExp }> = [
    { kind: "error", pattern: /\b(error|fail(?:ed|ure)?|denied|panic|fatal)\b/gi },
    { kind: "warning", pattern: /\b(warn(?:ing)?|caution)\b/gi },
    { kind: "success", pattern: /\b(success|ok|done|passed)\b/gi },
  ];
  const buffer = term.buffer.active;
  const matches: KeywordHighlight[] = [];

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        if (typeof match.index !== "number" || !match[0]) continue;
        const startCell = stringIndexToCell[match.index];
        const lastCell = stringIndexToCell[match.index + match[0].length - 1];
        if (typeof startCell !== "number" || typeof lastCell !== "number") continue;
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
          kind: rule.kind,
        });
      }
    }
  }

  return matches;
}

function firstVisibleMatchIndex(
  term: Terminal,
  matches: SearchMatch[],
  direction: "next" | "previous",
): number {
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;

  if (direction === "next") {
    const visible = matches.findIndex((match) => match.row >= viewportTop);
    return visible === -1 ? 0 : visible;
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].row <= viewportBottom) return i;
  }
  return matches.length - 1;
}

function normalizePasteText(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function timestampFilePart(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseOsc7(data: string): string | null {
  // OSC 7 payload looks like `file://hostname/path/with%20spaces`.
  const match = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function encodeBinaryStringBase64(str: string): string {
  let binary = "";
  for (let i = 0; i < str.length; i++) {
    binary += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}
