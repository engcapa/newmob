import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { Terminal, type IBufferLine } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  isCustomTerminalTheme,
  loadTerminalDefaultProfile,
  parseSessionOptions,
  resolveTerminalTheme,
  resolveTerminalThemeWithSystem,
  saveTerminalDefaultProfile,
  type TerminalProfile,
  type TerminalSyntaxMode,
  type UserCommonCommand,
} from "../../lib/terminalProfile";
import {
  getSessionNetworkSettings,
  toNetworkSettingsPayload,
} from "../../lib/networkSettings";
import { resolveThemeId } from "../../lib/themes";
import { buildTerminalThemeOptions } from "../theme/themePreviews";
import {
  getDefaultTerminalFontFamily,
  getPrimaryFontName,
  isMonospaceFont,
} from "../../lib/systemFonts";
import { TerminalAppearanceSettings } from "./TerminalAppearanceSettings";
import { TerminalAppearanceMenuPanel } from "./TerminalAppearanceMenuPanel";
import {
  attachTerminalImeGuard,
  shouldUseLinuxImeGuard,
  TerminalImeInputGuard,
} from "../../lib/terminalImeGuard";
import { shouldSuppressMacImeKeydown, clearStaleKeyDownSeen, clearStaleKeyDownSeenIfActive } from "../../lib/terminal/macImeKeydown";
import { isEditableTarget, isTerminalFocused } from "../../lib/terminal/keyboardGuards";
import {
  readFiles as clipboardReadFiles,
  parseFilePaths as clipboardParseFilePaths,
  readText as clipboardReadText,
  writeText as clipboardWriteText,
  writeMultiFormat as clipboardWriteMultiFormat,
} from "../../lib/clipboard";
import {
  captureContainerCanvasesPng,
  captureXtermFullBuffer,
  captureXtermVisible,
  renderXtermVisibleToCanvas,
  type XtermCaptureTheme,
} from "../../lib/capture";
import { useCaptureStore, type CaptureSource } from "../../stores/captureStore";
import { useAppTheme } from "../../lib/appTheme";
import { CaptureMenuButton } from "../capture/CaptureMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { Bot, ExternalLink, FolderOpen, Maximize2, Minimize2, X } from "lucide-react";
import {
  createOsc7BlankingSuppressor,
  createTaskStartOutputSuppressor,
  type InputEchoSuppressor,
} from "../../lib/terminalOutputFilter";
import { makeHostKey, useCommandHistory } from "../../lib/history";
import {
  createTerminalSessionId,
  attachTerminalOutput,
  createCommandTerminal,
  createLocalTerminal,
  createSshTerminal,
  recordLocalDirectoryUse,
  listenSshAuthPrompt,
  submitSshAuthResponse,
  type SshAuthPromptPayload,
  writeTerminal,
  resizeTerminal,
  sendTerminalSignal,
  closeTerminal,
  ccTrackTerminal,
  ccUntrackTerminal,
  listenTerminalExit,
  listenTerminalForwardError,
  encodeBase64,
  selectUploadFile,
  selectSaveDirectory,
  readStreamOpen,
  readStreamRead,
  readStreamClose,
  writeStreamOpen,
  writeStreamAppend,
  writeStreamClose,
  writeStreamAbort,
  checkFileExists,
  VAULT_LOCKED_EVENT,
  isVaultLockedError,
} from "../../lib/ipc";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { extractTerminalCommand } from "../../lib/terminalCommand";
import { normalizeLocalStartCwd } from "../../lib/terminalCwd";
import { inferTerminalProgram } from "../../lib/terminalActivity";
import { buildSshCwdIntegration, buildLocalZshCwdIntegration } from "../../lib/terminalShellIntegration";
import { buildInteractiveCommandInput, renderTerminalTask } from "../../lib/terminal/commandInput";
import { registerTerminal, consumeTerminalDetachPending } from "../../lib/terminal/terminalRegistry";
import {
  ZmodemSession,
  type ZmodemState,
  type ZmodemProgress,
  type ZmodemSendFile,
  type ConflictAction,
  type SendConflictAction,
} from "../../lib/zmodem";
import { ZmodemConflictDialog } from "./ZmodemConflictDialog";
import { MfaPrompt } from "../session/MfaPrompt";
import { CommonCommandsPalette } from "./CommonCommandsPalette";
import { AiRewriteOverlay } from "./AiRewriteOverlay";
import { SelectionToolbar } from "./SelectionToolbar";
import { useChatStore } from "../../stores/chatStore";
import { useSuggestionSource } from "../../lib/terminal/aiSuggestionSource";
import { WINDOWS_PRESET_COMMANDS } from "../../lib/commonCommandsPresets";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { promptAppDialog } from "../../lib/appDialogs";
import {
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDropDetail,
  droppedFilePaths,
  formatDroppedPathsForShell,
  isOsFileDrag,
  shellQuoteStyleForTerminalDrop,
} from "../../lib/osFileDrop";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { useT } from "../../lib/i18n";
import { gitProbePath, gitSnapshot } from "../../lib/git";
import {
  sockscapLaunchTerminalApp,
  sockscapStopLaunchedApp,
} from "../../lib/sockscap";
import type { SocksCapTerminalLaunchInfo } from "../../types";
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
}

export interface CommandTerminalConnectInfo {
  sessionId?: string;
  kind: "FTP" | "Telnet" | "Rlogin" | "Serial" | "Mosh";
  host: string;
  port: number;
  username?: string | null;
  optionsJson?: string | null;
}

export interface TerminalReattachState {
  terminalSessionId?: string;
  snapshotText?: string;
}

export interface AdoptedTerminalSession {
  sessionId: string;
  snapshotText?: string;
}

export interface DetachedTerminalWindowControls {
  onReattach: (state?: TerminalReattachState) => void;
  onToggleOsFullscreen: () => void;
  osFullscreen: boolean;
}

export interface TerminalLocalPathUploadRequest {
  paths: string[];
  cwd: string | null;
}

interface TerminalPanelProps {
  tabId?: string;
  tabTitle?: string;
  theme?: string;
  ssh?: SshConnectInfo;
  commandTerminal?: CommandTerminalConnectInfo;
  localShell?: {
    id: string;
    name: string;
    args?: string[];
  };
  terminalProfile?: TerminalProfile;
  onTerminalProfileChange?: (profile: TerminalProfile) => void;
  adoptedTerminal?: AdoptedTerminalSession;
  sockscapTerminal?: SocksCapTerminalLaunchInfo;
  /**
   * One-shot working directory for the initial connect. Local terminals launch
   * the shell here; SSH terminals `cd` here right after the shell opens. Used
   * when a terminal tab is duplicated so the copy lands in the source's cwd.
   */
  initialCwd?: string;
  /** Enables backend-owned SDK environment injection for workspace terminals. */
  workspaceRoot?: string;
  preserveSessionOnUnmount?: boolean;
  detachedWindowControls?: DetachedTerminalWindowControls;
  onDetachedStateChange?: (state: TerminalReattachState) => void;
  visible?: boolean;
  activeForShortcuts?: boolean;
  inputLocked?: boolean;
  onCwdChange?: (cwd: string) => void;
  /** Incremented by the parent when the SFTP panel explicitly asks for cwd. */
  cwdRequestToken?: number;
  /** Called once the backend terminal session ID is known (after connect). */
  onSessionReady?: (sessionId: string) => void;
  /**
   * Structured launch failure notification (design §4.1.5): called from
   * `handleConnectFailure` so the parent can complete a pending local-launch
   * request. Existing in-panel failure handling is unchanged.
   */
  onSessionLaunchFailed?: (error: unknown) => void;
  /** Called whenever the terminal receives output (for new-output badge). */
  onOutput?: () => void;
  /** Workspace task terminals report their shell exit marker through OSC 633. */
  onTaskExit?: (exitCode: number) => void;
  /** SSH-only: upload local OS file paths into the terminal's current remote cwd. */
  onUploadLocalPaths?: (request: TerminalLocalPathUploadRequest) => Promise<void> | void;
  /** Whether MultiExec broadcast mode is active globally. */
  multiExecActive?: boolean;
  /** Whether this terminal is a selected broadcast target (shows visual indicator). */
  isMultiExecTarget?: boolean;
  /** Called with user input when MultiExec is active; parent broadcasts to other terminals. */
  onInputBroadcast?: (data: string) => void;
  /** When set, the floating toolbar shows an SFTP toggle button. Only used
   *  for SSH terminals where the parent owns the attached SFTP sidebar. */
  sftpToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Floating-toolbar button for the AI chat thread bound to this tab. */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Local-terminal Git entry for the current working directory. */
  gitToggle?: {
    cwd: string | null;
    onOpen: () => void;
  };
  /** When set, the floating toolbar exposes a "Detach to its own window"
   *  button that calls back into MainLayout. Hidden in detached windows
   *  themselves (which already live in their own OS window). */
  detachToggle?: {
    onDetach: () => void;
  };
}

const DEFAULT_FONT_SIZE = 14;
const CWD_QUERY_COMMAND =
  " printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; : __taomni_cwd_sync_done";
// PowerShell equivalent of the OSC 7 cwd probe. `printf` doesn't exist in
// PowerShell, so we emit the escape sequence via [Console]::Write. The echo is
// hidden by the OSC-7 blanking suppressor (which keys off the real escape byte
// this prints at runtime), so no marker bookkeeping is needed here.
const PS_CWD_QUERY_COMMAND =
  "[Console]::Write([char]27+']7;file://'+$env:COMPUTERNAME+'/'+($PWD.ProviderPath.Replace('\\','/'))+[char]27+'\\')";
const OSC52_MAX_DECODED_BYTES = 1024 * 1024;

interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

interface KeywordHighlight extends SearchMatch {
  kind: "error" | "warning" | "success";
}

export interface TerminalBlockSelectionCell {
  row: number;
  col: number;
}

export interface TerminalBlockSelection {
  anchor: TerminalBlockSelectionCell;
  focus: TerminalBlockSelectionCell;
}

interface TerminalEventLogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
}

type TerminalConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "reconnecting";
type TerminalGitState =
  | { kind: "unknown"; label: string; title: string }
  | { kind: "repo"; label: string; title: string; repoRoot: string }
  | { kind: "none"; label: string; title: string }
  | { kind: "error"; label: string; title: string };

export function TerminalPanel({
  tabId,
  tabTitle = "Terminal",
  theme = "classic",
  ssh,
  commandTerminal,
  localShell,
  terminalProfile,
  onTerminalProfileChange,
  adoptedTerminal,
  sockscapTerminal,
  initialCwd,
  workspaceRoot,
  preserveSessionOnUnmount = false,
  detachedWindowControls,
  onDetachedStateChange,
  visible = true,
  activeForShortcuts = visible,
  inputLocked = false,
  onCwdChange,
  cwdRequestToken = 0,
  onSessionReady,
  onSessionLaunchFailed,
  onOutput,
  onTaskExit,
  onUploadLocalPaths,
  multiExecActive,
  isMultiExecTarget,
  onInputBroadcast,
  sftpToggle,
  chatToggle,
  gitToggle,
  detachToggle,
}: TerminalPanelProps) {
  const t = useT();
  const { confirm: confirmPaste, render: pasteConfirmDialog } = useConfirmDialog();
  const { confirm: confirmTerminalDefaults, render: terminalDefaultsConfirmDialog } = useConfirmDialog();
  const cwdCallbackRef = useRef<typeof onCwdChange>(onCwdChange);
  const onSessionReadyRef = useRef<typeof onSessionReady>(onSessionReady);
  const onSessionLaunchFailedRef = useRef<typeof onSessionLaunchFailed>(onSessionLaunchFailed);
  const onOutputRef = useRef<typeof onOutput>(onOutput);
  const onTaskExitRef = useRef<typeof onTaskExit>(onTaskExit);
  const onUploadLocalPathsRef = useRef<typeof onUploadLocalPaths>(onUploadLocalPaths);
  const onInputBroadcastRef = useRef<typeof onInputBroadcast>(onInputBroadcast);
  const onTerminalProfileChangeRef = useRef<typeof onTerminalProfileChange>(onTerminalProfileChange);
  const onDetachedStateChangeRef = useRef<typeof onDetachedStateChange>(onDetachedStateChange);
  const preserveSessionOnUnmountRef = useRef(preserveSessionOnUnmount);
  const adoptedTerminalRef = useRef(adoptedTerminal);
  const workspaceRootRef = useRef(workspaceRoot);
  const multiExecActiveRef = useRef(multiExecActive);
  useEffect(() => {
    cwdCallbackRef.current = onCwdChange;
    onSessionReadyRef.current = onSessionReady;
    onSessionLaunchFailedRef.current = onSessionLaunchFailed;
    onOutputRef.current = onOutput;
    onTaskExitRef.current = onTaskExit;
    onUploadLocalPathsRef.current = onUploadLocalPaths;
    onInputBroadcastRef.current = onInputBroadcast;
    onTerminalProfileChangeRef.current = onTerminalProfileChange;
    onDetachedStateChangeRef.current = onDetachedStateChange;
    preserveSessionOnUnmountRef.current = preserveSessionOnUnmount;
    workspaceRootRef.current = workspaceRoot;
    multiExecActiveRef.current = multiExecActive;
  }, [
    onCwdChange,
    onSessionReady,
    onOutput,
    onTaskExit,
    onUploadLocalPaths,
    onInputBroadcast,
    onTerminalProfileChange,
    onDetachedStateChange,
    preserveSessionOnUnmount,
    workspaceRoot,
    multiExecActive,
  ]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const connectionStateRef = useRef<TerminalConnectionState>("idle");
  const reconnectSshRef = useRef<(() => void) | null>(null);
  // Mirrors `sessionIdRef.current` as state so the registry-effect below
  // re-runs whenever the backend session id changes.
  const [registeredSessionId, setRegisteredSessionId] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const latestCwdRef = useRef<string | null>(initialCwd ?? null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const readOnlyRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fallbackSearchRef = useRef<{ query: string; index: number }>({ query: "", index: -1 });
  const contextMenu = useContextMenu();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const setTerminalRuntime = useAppStore((s) => s.setTerminalRuntime);
  const attachToComposer = useChatStore((s) => s.attachToComposer);
  const explainSelection = useChatStore((s) => s.explainSelection);
  const isLocal = !ssh && !commandTerminal;
  const supportsShellTools = !sockscapTerminal;
  const initialProfileRef = useRef<TerminalProfile | null>(null);
  if (!initialProfileRef.current) {
    initialProfileRef.current = terminalProfile ?? loadTerminalDefaultProfile();
  }
  const initialProfile = initialProfileRef.current;
  const appliedTerminalProfileSignatureRef = useRef<string | null>(
    terminalProfile ? terminalProfileSignature(terminalProfile) : null,
  );

  useEffect(() => {
    if (!tabId) return;
    setTerminalRuntime(tabId, { state: "connecting", program: undefined });
  }, [setTerminalRuntime, tabId]);
  const currentTerminalProfileRef = useRef<TerminalProfile>(initialProfile);

  const [fontFamily, setFontFamily] = useState(initialProfile.fontFamily);
  const [fontSize, setFontSize] = useState(initialProfile.fontSize);
  const [fontLigatures, setFontLigatures] = useState(initialProfile.fontLigatures);
  const [showScrollbar, setShowScrollbar] = useState(initialProfile.showScrollbar);
  const [webglRenderer, setWebglRenderer] = useState(initialProfile.webglRenderer);
  const [readOnly, setReadOnly] = useState(initialProfile.readOnly);
  const [themeName, setThemeName] = useState(initialProfile.theme || theme);
  const { resolvedTheme: resolvedAppTheme } = useAppTheme();
  const appPrefersDark = resolvedAppTheme === "dark";
  const resolvePanelTheme = useCallback(
    (name: string) => resolveTerminalThemeWithSystem(name, appPrefersDark),
    [appPrefersDark],
  );
  const [cursorStyle, setCursorStyle] = useState(initialProfile.cursorStyle);
  const [cursorBlink, setCursorBlink] = useState(initialProfile.cursorBlink);
  const [scrollback, setScrollback] = useState(initialProfile.scrollback);
  const [syntaxMode, setSyntaxMode] = useState<TerminalSyntaxMode>(initialProfile.syntaxMode);
  const [rightClickBehavior, setRightClickBehavior] = useState(initialProfile.rightClickBehavior);
  const [copyOnSelect, setCopyOnSelect] = useState(initialProfile.copyOnSelect);
  const [allowRemoteOsc52Clipboard, setAllowRemoteOsc52Clipboard] = useState(initialProfile.allowRemoteOsc52Clipboard);
  const [loggingActive, setLoggingActive] = useState(initialProfile.loggingEnabled);
  const [multilinePasteConfirm, setMultilinePasteConfirm] = useState(initialProfile.multilinePasteConfirm);
  const [inlineSuggestionsEnabled, setInlineSuggestionsEnabled] = useState(initialProfile.inlineSuggestions);
  const [inlineSuggestionsMax, setInlineSuggestionsMax] = useState(initialProfile.inlineSuggestionsMax);
  const [inlineSuggestionsSource, setInlineSuggestionsSource] = useState(initialProfile.inlineSuggestionsSource);
  const [aiCommandRewriteEnabled, setAiCommandRewriteEnabled] = useState(initialProfile.aiCommandRewriteEnabled);
  const [aiRewriteOpen, setAiRewriteOpen] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{
    rect: { top: number; left: number; right: number; bottom: number };
    text: string;
  } | null>(null);
  const [blockSelection, setBlockSelection] = useState<TerminalBlockSelection | null>(null);
  const [commonCommands, setCommonCommands] = useState<UserCommonCommand[]>(initialProfile.commonCommands);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

  const commitTerminalProfilePatch = useCallback((patch: Partial<TerminalProfile>) => {
    const next: TerminalProfile = { ...currentTerminalProfileRef.current, ...patch };
    currentTerminalProfileRef.current = next;

    if (patch.fontFamily !== undefined) setFontFamily(next.fontFamily);
    if (patch.fontSize !== undefined) setFontSize(next.fontSize);
    if (patch.fontLigatures !== undefined) setFontLigatures(next.fontLigatures);
    if (patch.showScrollbar !== undefined) setShowScrollbar(next.showScrollbar);
    if (patch.webglRenderer !== undefined) setWebglRenderer(next.webglRenderer);
    if (patch.readOnly !== undefined) setReadOnly(next.readOnly);
    if (patch.theme !== undefined) setThemeName(next.theme || theme);
    if (patch.cursorStyle !== undefined) setCursorStyle(next.cursorStyle);
    if (patch.cursorBlink !== undefined) setCursorBlink(next.cursorBlink);
    if (patch.scrollback !== undefined) setScrollback(next.scrollback);
    if (patch.syntaxMode !== undefined) setSyntaxMode(next.syntaxMode);
    if (patch.rightClickBehavior !== undefined) setRightClickBehavior(next.rightClickBehavior);
    if (patch.copyOnSelect !== undefined) setCopyOnSelect(next.copyOnSelect);
    if (patch.allowRemoteOsc52Clipboard !== undefined) {
      setAllowRemoteOsc52Clipboard(next.allowRemoteOsc52Clipboard);
    }
    if (patch.loggingEnabled !== undefined) setLoggingActive(next.loggingEnabled);
    if (patch.multilinePasteConfirm !== undefined) {
      setMultilinePasteConfirm(next.multilinePasteConfirm);
    }
    if (patch.inlineSuggestions !== undefined) setInlineSuggestionsEnabled(next.inlineSuggestions);
    if (patch.inlineSuggestionsMax !== undefined) setInlineSuggestionsMax(next.inlineSuggestionsMax);
    if (patch.inlineSuggestionsSource !== undefined) {
      setInlineSuggestionsSource(next.inlineSuggestionsSource);
    }
    if (patch.aiCommandRewriteEnabled !== undefined) {
      setAiCommandRewriteEnabled(next.aiCommandRewriteEnabled);
    }
    if (patch.commonCommands !== undefined) setCommonCommands(next.commonCommands);

    onTerminalProfileChangeRef.current?.(next);
  }, [theme]);

  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    currentTerminalProfileRef.current = {
      ...currentTerminalProfileRef.current,
      fontFamily,
      fontSize,
      fontLigatures,
      theme: themeName,
      scrollback,
      cursorStyle,
      cursorBlink,
      showScrollbar,
      webglRenderer,
      readOnly,
      syntaxMode,
      rightClickBehavior,
      copyOnSelect,
      allowRemoteOsc52Clipboard,
      loggingEnabled: loggingActive,
      multilinePasteConfirm,
      inlineSuggestions: inlineSuggestionsEnabled,
      inlineSuggestionsMax,
      inlineSuggestionsSource,
      aiCommandRewriteEnabled,
      commonCommands,
    };
  }, [
    aiCommandRewriteEnabled,
    allowRemoteOsc52Clipboard,
    commonCommands,
    copyOnSelect,
    cursorBlink,
    cursorStyle,
    fontFamily,
    fontLigatures,
    fontSize,
    inlineSuggestionsEnabled,
    inlineSuggestionsMax,
    inlineSuggestionsSource,
    loggingActive,
    multilinePasteConfirm,
    readOnly,
    rightClickBehavior,
    scrollback,
    showScrollbar,
    syntaxMode,
    themeName,
    webglRenderer,
  ]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [eventLog, setEventLog] = useState<TerminalEventLogEntry[]>([]);
  const [macroRecording, setMacroRecording] = useState(false);
  const [zmodemState, setZmodemState] = useState<ZmodemState>("idle");
  const [zmodemProgress, setZmodemProgress] = useState<ZmodemProgress | null>(null);
  const zmodemRef = useRef<ZmodemSession | null>(null);
  const zmodemSaveDirRef = useRef<string | undefined>(undefined);
  const [conflictDialogState, setConflictDialogState] = useState<{
    fileName: string;
    hasMore: boolean;
    mode: "receive" | "send";
    resolve: (action: ConflictAction | SendConflictAction) => void;
  } | null>(null);
  // Pending keyboard-interactive (MFA/OTP) auth prompt surfaced mid-connect.
  // `null` when no prompt is active.
  const [mfaPrompt, setMfaPrompt] = useState<SshAuthPromptPayload | null>(null);
  // Holds the request id of the prompt awaiting an answer so unmount cleanup
  // can cancel an unanswered round (telling the backend to abort connect).
  const pendingMfaRequestIdRef = useRef<string | null>(null);
  const outputLogRef = useRef("");
  const loggingActiveRef = useRef(loggingActive);
  const copyOnSelectRef = useRef(copyOnSelect);
  const webglRendererRef = useRef(webglRenderer);
  const allowRemoteOsc52ClipboardRef = useRef(allowRemoteOsc52Clipboard);
  const macroRecordingRef = useRef(macroRecording);
  const macroBufferRef = useRef("");
  const lastMacroRef = useRef("");
  const macroPlaybackRef = useRef(false);
  const eventIdRef = useRef(0);
  const imeGuardRef = useRef<TerminalImeInputGuard | null>(null);
  const isComposingRef = useRef(false);
  const compositionBufferRef = useRef<Uint8Array[]>([]);
  const injectedInputEchoSuppressorRef = useRef<InputEchoSuppressor | null>(null);
  // SSH login scripts and startup commands can take longer than the initial
  // polling window. Keep a deferred installer so the first later idle prompt
  // can still enable continuous OSC 7 cwd reporting.
  const installSshCwdIntegrationRef = useRef<(() => boolean) | null>(null);
  const webglAddonRef = useRef<{
    addon: WebglAddon;
    contextLossDisposable: { dispose: () => void } | null;
  } | null>(null);
  const suppressNativePasteUntilRef = useRef(0);
  const middleClickSelectionRef = useRef("");
  const blockSelectionRef = useRef<TerminalBlockSelection | null>(null);
  const blockSelectionTextRef = useRef("");
  const lastMacMiddlePasteAtRef = useRef(0);
  const lastTerminalSizeSyncRef = useRef<{ sessionId: string; cols: number; rows: number } | null>(null);
  const lastCwdRequestTokenRef = useRef(cwdRequestToken);

  const syncTerminalSize = useCallback((force = false) => {
    const sid = sessionIdRef.current;
    const term = termRef.current;
    if (!sid || !term) return;

    const { cols, rows } = currentTerminalSize(term);
    const previous = lastTerminalSizeSyncRef.current;
    if (!force && previous?.sessionId === sid && previous.cols === cols && previous.rows === rows) {
      return;
    }
    lastTerminalSizeSyncRef.current = { sessionId: sid, cols, rows };
    resizeTerminal(sid, cols, rows).catch(() => {
      if (lastTerminalSizeSyncRef.current?.sessionId === sid) {
        lastTerminalSizeSyncRef.current = null;
      }
    });
  }, []);

  const fitVisibleTerminal = useCallback((forceSync = false) => {
    const el = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !term || !fitAddon || el.clientWidth === 0 || el.clientHeight === 0) {
      return;
    }

    try {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
      syncTerminalSize(forceSync);
    } catch {
      // Hidden tabs can briefly report invalid dimensions while switching.
    }
  }, [syncTerminalSize]);

  const scheduleTerminalFitAndSync = useCallback((forceSync = false) => {
    const run = () => {
      if (!termRef.current) return;
      window.requestAnimationFrame(() => {
        if (termRef.current) fitVisibleTerminal(forceSync);
      });
    };
    run();
    window.setTimeout(run, 80);
    window.setTimeout(run, 300);
  }, [fitVisibleTerminal]);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const disposeTerminalWebgl = useCallback((term: Terminal | null) => {
    const record = webglAddonRef.current;
    if (!record) return;

    webglAddonRef.current = null;
    record.contextLossDisposable?.dispose();
    try {
      record.addon.dispose();
    } catch {
      /* WebGL addon disposal is best-effort during renderer fallback. */
    }
    if (term) {
      term.refresh(0, Math.max(0, term.rows - 1));
    }
  }, []);

  const installTerminalWebgl = useCallback((term: Terminal) => {
    if (!shouldUseTerminalWebgl(webglRendererRef.current) || webglAddonRef.current) return;

    let addon: WebglAddon | null = null;
    let contextLossDisposable: { dispose: () => void } | null = null;
    try {
      addon = new WebglAddon();
      const currentAddon = addon;
      contextLossDisposable = currentAddon.onContextLoss(() => {
        if (webglAddonRef.current?.addon !== currentAddon) return;
        disposeTerminalWebgl(term);
        setStatusMessage("Terminal WebGL renderer lost; using stable renderer");
      });
      term.loadAddon(currentAddon);
      webglAddonRef.current = { addon: currentAddon, contextLossDisposable };
    } catch {
      contextLossDisposable?.dispose();
      try {
        addon?.dispose();
      } catch {
        /* WebGL not available. */
      }
    }
  }, [disposeTerminalWebgl, setStatusMessage]);

  const collectReattachState = useCallback((): TerminalReattachState => {
    const term = termRef.current;
    return {
      terminalSessionId: sessionIdRef.current ?? undefined,
      snapshotText: term ? getBufferText(term) : undefined,
    };
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



  // Per-host command history for inline ghost-text suggestions.
  const historyHostKey = useMemo(
    () => commandTerminal
      ? `client:${commandTerminal.kind}:${commandTerminal.host.toLowerCase()}:${commandTerminal.port}:${commandTerminal.username ?? ""}`
      : makeHostKey(ssh),
    [commandTerminal, ssh],
  );
  // Tracks which local shell the backend actually launched. Lets us suppress
  // inline history suggestions on shells that already provide their own
  // (PSReadLine on PowerShell). Resolved on connect — the prop only carries
  // the user's selection, which can be missing when opening a saved
  // LocalShell session, so we trust the backend's resolved id instead.
  const [resolvedLocalShellId, setResolvedLocalShellId] = useState<string | null>(null);
  const isLocalPowerShell = useMemo(
    () =>
      isLocal &&
      (resolvedLocalShellId
        ? (resolvedLocalShellId === "powershell" || resolvedLocalShellId === "windows-powershell")
        : (localShell?.id === "powershell" || localShell?.id === "windows-powershell")),
    [isLocal, resolvedLocalShellId, localShell?.id],
  );
  const suggestionsActive =
    supportsShellTools && inlineSuggestionsEnabled && !isLocalPowerShell;
  const history = useCommandHistory(historyHostKey, inlineSuggestionsMax);

  // Which command (if any) can probe this terminal's cwd via OSC 7. SSH and
  // POSIX local shells use the `printf` form; PowerShell uses a [Console]::Write
  // form; cmd.exe can't emit OSC 7 cleanly, so it has no probe. Resolved
  // reactively because the backend reports the real local shell on connect.
  const isLocalCmd = useMemo(
    () =>
      isLocal &&
      (resolvedLocalShellId === "command-prompt" ||
        /cmd\.exe|command[\s-]?prompt/i.test(`${localShell?.id ?? ""} ${localShell?.name ?? ""}`)),
    [isLocal, resolvedLocalShellId, localShell?.id, localShell?.name],
  );
  const cwdProbeCommand = useMemo<string | null>(() => {
    if (commandTerminal || sockscapTerminal) return null;
    if (!isLocal) return CWD_QUERY_COMMAND; // SSH → remote POSIX shell.
    if (isLocalCmd) return null;
    if (isLocalPowerShell) return PS_CWD_QUERY_COMMAND;
    return CWD_QUERY_COMMAND; // bash/zsh/git-bash/WSL/Unix default.
  }, [isLocal, isLocalCmd, isLocalPowerShell, sockscapTerminal]);
  const cwdProbeCommandRef = useRef(cwdProbeCommand);
  useEffect(() => {
    cwdProbeCommandRef.current = cwdProbeCommand;
  }, [cwdProbeCommand]);

  const [gitState, setGitState] = useState<TerminalGitState>({
    kind: "unknown",
    label: "Git",
    title: "Open Git panel",
  });

  useEffect(() => {
    if (!isLocal || !gitToggle) {
      setGitState({ kind: "unknown", label: "Git", title: "Open Git panel" });
      return;
    }
    const cwd = gitToggle.cwd?.trim();
    if (!cwd) {
      setGitState({ kind: "unknown", label: "Git", title: "Waiting for terminal cwd" });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      gitProbePath(cwd)
        .then(async (probe) => {
          if (cancelled) return;
          if (!probe.gitAvailable) {
            setGitState({ kind: "error", label: "Git", title: probe.error ?? "Git executable was not found" });
            return;
          }
          if (!probe.isRepo || !probe.repoRoot) {
            setGitState({ kind: "none", label: "Git", title: "Initialize Git repository" });
            return;
          }
          try {
            const snapshot = await gitSnapshot(probe.repoRoot);
            if (cancelled) return;
            setGitState({
              kind: "repo",
              label: snapshot.currentBranch ?? snapshot.headOid ?? "repo",
              title: `Open Git panel for ${probe.repoRoot}`,
              repoRoot: probe.repoRoot,
            });
          } catch {
            if (!cancelled) {
              setGitState({ kind: "repo", label: "repo", title: `Open Git panel for ${probe.repoRoot}`, repoRoot: probe.repoRoot });
            }
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setGitState({
              kind: "error",
              label: "Git",
              title: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [gitToggle?.cwd, isLocal]);

  // Refs decouple the once-mounted xterm.onData callback from the live
  // history/enabled values. Without this, the initial writeXtermInput closure
  // captures the empty prewarm cache and never sees later state changes.
  const historyRef = useRef(history);
  const suggestionsActiveRef = useRef(suggestionsActive);
  const inlineSuggestionsSourceRef = useRef(inlineSuggestionsSource);
  const isLocalRef = useRef(isLocal);
  /** Last absolute local cwd we already recorded into command history. */
  const lastRecordedLocalDirRef = useRef<string | null>(null);
  /** OSC-7 reports can arrive before the async PTY creation result. */
  const pendingLocalDirectoryReportsRef = useRef<string[]>([]);
  useEffect(() => {
    historyRef.current = history;
    suggestionsActiveRef.current = suggestionsActive;
    inlineSuggestionsSourceRef.current = inlineSuggestionsSource;
    isLocalRef.current = isLocal;
  }, [history, suggestionsActive, inlineSuggestionsSource, isLocal]);

  // AI suggestion source resolver (data sources 2 + 3).
  // The resolver caches its options on every render; passing a thunk for
  // recent history keeps it invalidation-free without triggering rerenders.
  const recentHistoryForSuggestion = useMemo(
    () => history.recent(5),
    // The history hook bumps a cache version internally on commit, but we
    // only want to pull a fresh snapshot for new keystrokes — depending on
    // history alone here is fine because match() is the keystroke trigger.
    [history],
  );
  const resolveSuggestion = useSuggestionSource({
    source: inlineSuggestionsSource,
    isLocal,
    recentHistory: recentHistoryForSuggestion,
  });

  // State shared between onData tracking and the ghost renderer.
  const pendingRef = useRef("");
  const invalidatedRef = useRef(false);
  const suggestionRef = useRef<string | null>(null);
  const [ghostTick, setGhostTick] = useState(0);
  const ghostVisibleRef = useRef(false);

  const bumpGhost = useCallback(() => setGhostTick((v) => v + 1), []);

  const refreshSuggestion = useCallback(() => {
    if (!suggestionsActiveRef.current || invalidatedRef.current || pendingRef.current === "") {
      if (suggestionRef.current !== null) {
        suggestionRef.current = null;
      }
      bumpGhost();
      return;
    }
    const prefix = pendingRef.current;
    const matches = historyRef.current.match(prefix, 1);
    const historyMatch = matches[0] && matches[0].length > prefix.length ? matches[0] : null;

    if (historyMatch !== null) {
      // Source 1 hit — use immediately.
      suggestionRef.current = historyMatch;
      bumpGhost();
      return;
    }

    // Source 1 miss — try sources 2/3 asynchronously.
    const source = inlineSuggestionsSourceRef.current;
    if (source === "history+path" || source === "history+path+ai") {
      void resolveSuggestion(prefix, null, (result) => {
        // Only apply if the prefix hasn't changed since we started.
        if (pendingRef.current === prefix && !invalidatedRef.current) {
          suggestionRef.current = result;
          bumpGhost();
        }
      });
    } else {
      suggestionRef.current = null;
      bumpGhost();
    }
  }, [bumpGhost, resolveSuggestion]);

  const invalidatePending = useCallback(() => {
    if (invalidatedRef.current && suggestionRef.current === null) return;
    invalidatedRef.current = true;
    suggestionRef.current = null;
    bumpGhost();
  }, [bumpGhost]);

  const trackPending = useCallback((data: string) => {
    // History commit on Enter is always needed (Welcome recent-folders reads
    // host_key=local command history). Ghost-text suggestion tracking is
    // separate and only runs when suggestions are enabled — PowerShell local
    // shells disable suggestions (PSReadLine owns that UX) but still must
    // record typed commands.
    const suggestionsOn = suggestionsActiveRef.current;

    // Bracketed paste: whole block is shell input, never a typed command.
    if (data.startsWith("\x1b[200~")) {
      if (suggestionsOn) invalidatePending();
      return;
    }

    // Defensive: large chunk with any control char → treat as paste, invalidate.
    if (data.length > 64) {
      if (suggestionsOn) invalidatePending();
      return;
    }

    let changed = false;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);

      // CR / LF → Enter: commit the actual command on screen (handles Tab
      // completion, history recall, etc.), fall back to tracked pending.
      if (code === 0x0d || code === 0x0a) {
        let committed: string | null = null;
        const term = termRef.current;
        if (term && term.buffer.active.type !== "alternate") {
          const fromBuffer = captureBufferCommand(term);
          if (fromBuffer) committed = fromBuffer;
        }
        if (!committed && pendingRef.current !== "" && !invalidatedRef.current) {
          committed = pendingRef.current;
        }
        if (committed) historyRef.current.commit(committed);
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Below: only track keystrokes for ghost-text when suggestions are on.
      if (!suggestionsOn) {
        continue;
      }

      // Ctrl+C: cancel current line entirely, but re-enable suggestions immediately.
      if (code === 0x03) {
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Backspace / DEL.
      if (code === 0x08 || code === 0x7f) {
        if (!invalidatedRef.current && pendingRef.current.length > 0) {
          pendingRef.current = pendingRef.current.slice(0, -1);
          changed = true;
        }
        continue;
      }

      // Escape or any CSI-like sequence — arrows, Home/End, Tab completion, function
      // keys: give up on the current line until the next Enter.
      if (code === 0x1b || code === 0x09) {
        invalidatedRef.current = true;
        changed = true;
        // Skip rest of this data chunk; it's almost certainly a single escape seq.
        break;
      }

      // Other C0 control chars (Ctrl+A/E/U/W/K/L/R/...) → invalidate.
      if (code < 0x20) {
        invalidatedRef.current = true;
        changed = true;
        break;
      }

      // Printable: append unless we're already invalidated.
      if (!invalidatedRef.current) {
        pendingRef.current += data[i];
        changed = true;
      }
    }

    if (changed && suggestionsOn) refreshSuggestion();
  }, [invalidatePending, refreshSuggestion]);

  // Rerun suggestion matching whenever the live cache or the on/off toggles
  // change — this is what picks up a freshly-prewarmed history list.
  useEffect(() => {
    refreshSuggestion();
  }, [suggestionsActive, history, refreshSuggestion]);

  const sendTerminalInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current || connectionStateRef.current !== "connected") return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBase64(data)).catch(console.error);
  }, []);

  const writeInput = sendTerminalInput;

  // Broadcast-aware input: used for paste and any injected text so that
  // MultiExec mode forwards the same data to all selected terminals.
  const writeBroadcastInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    if (!sessionIdRef.current || connectionStateRef.current !== "connected") {
      if (ssh && connectionStateRef.current === "disconnected") {
        setStatusMessage("SSH disconnected; press Enter to reconnect");
      }
      return;
    }
    if (tabId && /[\r\n]/.test(data)) {
      const program = inferTerminalProgram(data.split(/[\r\n]/).find((line) => line.trim()) ?? "");
      if (program) {
        setTerminalRuntime(tabId, {
          state: "running",
          program,
          activitySource: "input-heuristic",
        });
      }
    }
    trackPending(data);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(data);
    }
    sendTerminalInput(data);
  }, [sendTerminalInput, setStatusMessage, setTerminalRuntime, ssh, tabId, trackPending]);

  const writeXtermInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    const filtered = imeGuardRef.current?.filterTerminalData(data) ?? data;
    if (filtered === null) {
      return;
    }

    if (
      ssh &&
      !adoptedTerminalRef.current &&
      connectionStateRef.current === "disconnected" &&
      (filtered === "\r" || filtered === "\n" || filtered === "\r\n")
    ) {
      reconnectSshRef.current?.();
      return;
    }

    if (connectionStateRef.current !== "connected") {
      if (ssh && connectionStateRef.current === "disconnected") {
        setStatusMessage("SSH disconnected; press Enter to reconnect");
      }
      return;
    }

    // `??` inline interceptor: when the user has typed `?? <question>` and
    // presses Enter on a normal-screen prompt, capture the question and
    // route it to the AI Chat Drawer instead of forwarding to the shell.
    // Disabled in alt-screen mode (vim/less/top), in PowerShell, and during
    // multi-exec broadcast.
    const endsWithEnter = filtered.endsWith("\r") || filtered.endsWith("\n");
    if (endsWithEnter && !multiExecActiveRef.current) {
      const term = termRef.current;
      const altScreen = term?.buffer.active.type === "alternate";
      const candidate = pendingRef.current + filtered.slice(0, filtered.length - 1);
      if (
        !altScreen
        && !isLocalPowerShell
        && candidate.startsWith("?? ")
        && candidate.length > 3
      ) {
        const question = candidate.slice(3).trim();
        // Clear the line on the shell (Ctrl+U wipes back to start in bash/zsh).
        sendTerminalInput("\x15");
        pendingRef.current = "";
        invalidatedRef.current = false;
        refreshSuggestion();

        if (terminalProfile?.aiInlineQqRender) {
          // Plan §8.4 inline path: render AI response directly into the
          // terminal as ANSI-styled lines. We write a header, kick the
          // backend stream, and pipe each token straight into xterm.write.
          const term = termRef.current;
          if (term) {
            void streamInlineAi(term, question);
          }
        } else {
          // Default safe path: route to AI Chat Drawer.
          void useChatStore.getState().attachToComposer(`?? ${question}`);
        }
        return;
      }
    }

    if (endsWithEnter && tabId) {
      const term = termRef.current;
      const submittedChunk = filtered.replace(/[\r\n]+$/g, "");
      const command =
        term && term.buffer.active.type !== "alternate"
          ? captureBufferCommand(term) || `${pendingRef.current}${submittedChunk}`
          : `${pendingRef.current}${submittedChunk}`;
      const program = inferTerminalProgram(command);
      if (program) {
        setTerminalRuntime(tabId, {
          state: "running",
          program,
          activitySource: "input-heuristic",
        });
      }
    }

    trackPending(filtered);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(filtered);
    }
    sendTerminalInput(filtered);
  }, [sendTerminalInput, setStatusMessage, setTerminalRuntime, ssh, tabId, trackPending, refreshSuggestion, isLocalPowerShell, terminalProfile?.aiInlineQqRender]);

  const writeBinaryInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current || connectionStateRef.current !== "connected") return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBinaryStringBase64(data)).catch(console.error);
  }, []);

  const requestTerminalCwd = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setStatusMessage("Terminal is not ready yet");
      return;
    }
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    const command = cwdProbeCommandRef.current;
    if (!command) {
      // No way to read the cwd for this shell (e.g. cmd.exe).
      setStatusMessage("This shell can't report its working directory");
      return;
    }

    // Never inject when a command is already typed but not yet run: the probe
    // would be appended to it, corrupting both the probe and the user's input.
    // captureBufferCommand reads the rendered current line, so this is
    // shell-agnostic and covers PowerShell too (where pendingRef isn't tracked).
    const term = termRef.current;
    if (term && captureBufferCommand(term).length > 0) {
      setStatusMessage("Can't read the working directory while a command is typed");
      return;
    }

    // Hide the probe's echo: drop everything until the OSC 7 reply it emits.
    injectedInputEchoSuppressorRef.current = createOsc7BlankingSuppressor();
    writeTerminal(sid, encodeBase64(`${command}\r`)).catch((err) => {
      if (sessionIdRef.current === sid) injectedInputEchoSuppressorRef.current = null;
      setStatusMessage(err instanceof Error ? err.message : "Terminal cwd request failed");
    });
  }, [setStatusMessage]);

  const writeClipboardText = useCallback(async (text: string, successMessage: string) => {
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }
    try {
      await clipboardWriteText(text);
      setStatusMessage(successMessage);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard copy failed");
    }
  }, [setStatusMessage]);

  const showTerminalSelectionToolbar = useCallback((text: string) => {
    if (!text || text.trim().length < 2) {
      setSelectionToolbar(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setSelectionToolbar({
      text,
      rect: {
        top: rect.top + 24,
        left: rect.left + rect.width / 3,
        right: rect.right,
        bottom: rect.bottom,
      },
    });
  }, []);

  const updateTerminalBlockSelection = useCallback((next: TerminalBlockSelection | null) => {
    blockSelectionRef.current = next;
    const term = termRef.current;
    blockSelectionTextRef.current = next && term ? collectTerminalBlockSelectionText(term, next) : "";
    setBlockSelection(next);
    if (!next) {
      setSelectionToolbar(null);
    }
  }, []);

  const getActiveTerminalSelectionText = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const block = blockSelectionRef.current;
    if (block) {
      const text = blockSelectionTextRef.current || collectTerminalBlockSelectionText(term, block);
      if (text) return text;
    }
    return term.getSelection();
  }, []);

  const clearTerminalBlockSelection = useCallback(() => {
    updateTerminalBlockSelection(null);
  }, [updateTerminalBlockSelection]);

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    await writeClipboardText(getActiveTerminalSelectionText(), "Copied selection");
    focusTerminal();
  }, [focusTerminal, getActiveTerminalSelectionText, writeClipboardText]);

  const copyAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(getBufferText(term), "Copied terminal buffer");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyFormattedSelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = getActiveTerminalSelectionText();
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }

    const resolvedTheme = resolvePanelTheme(themeName);
    const html = `<pre style="margin:0;font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px;background:${resolvedTheme.background ?? "#1d1f21"};color:${resolvedTheme.foreground ?? "#eaeaea"};white-space:pre-wrap;">${escapeHtml(text)}</pre>`;

    try {
      await clipboardWriteMultiFormat({ text, html });
      setStatusMessage("Copied formatted selection");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Formatted copy failed");
    } finally {
      focusTerminal();
    }
  }, [focusTerminal, fontFamily, fontSize, getActiveTerminalSelectionText, resolvePanelTheme, setStatusMessage, themeName, writeClipboardText]);

  const pasteTextIntoTerminal = useCallback(async (text: string): Promise<boolean> => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return false;
    }

    if (!text) return false;
    if (multilinePasteConfirm && /\r?\n/.test(text)) {
      const lineCount = text.split(/\r?\n/).length;
      const ok = await confirmPaste({
        title: t("terminal.multilinePasteTitle"),
        message: t("terminal.multilinePasteMessage", { count: lineCount }),
        confirmLabel: t("terminal.paste"),
      });
      if (!ok) return false;
    }
    writeBroadcastInput(formatPasteForTerminal(termRef.current, text));
    focusTerminal();
    return true;
  }, [confirmPaste, focusTerminal, multilinePasteConfirm, setStatusMessage, t, writeBroadcastInput]);

  const handleTerminalDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (readOnlyRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const insertFilePaths = useCallback((paths: string[]) => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      focusTerminal();
      return;
    }

    const quoteStyle = shellQuoteStyleForTerminalDrop({
      isSsh: !isLocal,
      localShellId: resolvedLocalShellId ?? localShell?.id ?? null,
    });
    const text = formatDroppedPathsForShell(paths, quoteStyle);
    if (!text) return;

    writeBroadcastInput(formatPasteForTerminal(termRef.current, text));
    appendEvent("input", `Inserted ${paths.length} dropped file path${paths.length === 1 ? "" : "s"}`);
    setStatusMessage(`Inserted ${paths.length} file path${paths.length === 1 ? "" : "s"}`);
    focusTerminal();
  }, [appendEvent, focusTerminal, isLocal, localShell?.id, resolvedLocalShellId, setStatusMessage, writeBroadcastInput]);

  const handleLocalFilePaths = useCallback(async (paths: string[]) => {
    const cleanPaths = uniqueNonEmpty(paths);
    if (cleanPaths.length === 0) return;
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      focusTerminal();
      return;
    }

    const term = termRef.current;
    const upload = onUploadLocalPathsRef.current;
    const canOfferUpload =
      !isLocal &&
      !!upload &&
      terminalCanPromptForLocalPathUpload(term);
    if (!canOfferUpload) {
      insertFilePaths(cleanPaths);
      return;
    }

    const cwd = latestCwdRef.current;
    const confirmed = await confirmPaste({
      title: t("terminal.filePasteTitle"),
      message: t("terminal.filePasteMessage", {
        count: cleanPaths.length,
        cwd: cwd ?? t("terminal.filePasteUnknownCwd"),
      }),
      confirmLabel: t("terminal.filePasteUpload"),
      cancelLabel: t("terminal.filePastePaths"),
    });

    if (!confirmed) {
      insertFilePaths(cleanPaths);
      return;
    }

    try {
      await upload({ paths: cleanPaths, cwd });
      setStatusMessage(t("terminal.filePasteUploadQueued", { count: cleanPaths.length }));
      focusTerminal();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Upload failed");
      focusTerminal();
    }
  }, [confirmPaste, focusTerminal, insertFilePaths, isLocal, setStatusMessage, t]);

  const pasteFromClipboard = useCallback(async () => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    try {
      if (!isLocal && onUploadLocalPathsRef.current) {
        const paths = await clipboardReadFiles();
        if (paths.length > 0) {
          await handleLocalFilePaths(paths);
          return;
        }
      }
      const text =
        (await clipboardReadText()) ||
        (await promptAppDialog({
          title: "Paste text",
          initialValue: "",
          allowEmpty: true,
        })) ||
        "";
      if (!text) return;

      if (!isLocal && onUploadLocalPathsRef.current) {
        const textPaths = await clipboardParseFilePaths(text);
        if (textPaths.length > 0) {
          await handleLocalFilePaths(textPaths);
          return;
        }
      }

      await pasteTextIntoTerminal(text);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
    }
  }, [handleLocalFilePaths, isLocal, pasteTextIntoTerminal, setStatusMessage]);

  const handleTerminalDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();

    const paths = droppedFilePaths(event.dataTransfer);
    if (paths.length === 0) {
      setStatusMessage("Dropped file paths are not available in this environment");
      focusTerminal();
      return;
    }

    void handleLocalFilePaths(paths);
  }, [focusTerminal, handleLocalFilePaths, setStatusMessage]);

  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;

      const panel = panelRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!panel || !target || !panel.contains(target)) return;

      void handleLocalFilePaths(detail.paths);
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [handleLocalFilePaths]);

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
    clearTerminalBlockSelection();
    focusTerminal();
  }, [clearTerminalBlockSelection, focusTerminal]);

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
    clearTerminalBlockSelection();
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
  }, [clearTerminalBlockSelection, searchValue]);

  const renameTerminal = useCallback(async () => {
    if (!tabId) return;
    const nextTitle = await promptAppDialog({
      title: "Set terminal title",
      initialValue: tabTitle,
      allowEmpty: true,
    });
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
    const nextSize = Math.min(currentTerminalProfileRef.current.fontSize + 1, 32);
    commitTerminalProfilePatch({ fontSize: nextSize });
  }, [commitTerminalProfilePatch]);

  const decreaseFontSize = useCallback(() => {
    const nextSize = Math.max(currentTerminalProfileRef.current.fontSize - 1, 8);
    commitTerminalProfilePatch({ fontSize: nextSize });
  }, [commitTerminalProfilePatch]);

  const resetFontSize = useCallback(() => {
    commitTerminalProfilePatch({ fontSize: DEFAULT_FONT_SIZE });
  }, [commitTerminalProfilePatch]);

  const setSyntaxModeAndFocus = useCallback((mode: TerminalSyntaxMode) => {
    commitTerminalProfilePatch({ syntaxMode: mode });
    focusTerminal();
  }, [commitTerminalProfilePatch, focusTerminal]);

  const saveCurrentAppearanceAsTerminalDefault = useCallback(() => {
    const currentDefault = loadTerminalDefaultProfile();
    const currentProfile = currentTerminalProfileRef.current;
    saveTerminalDefaultProfile({
      ...currentDefault,
      theme: currentProfile.theme,
      fontFamily: currentProfile.fontFamily,
      fontSize: currentProfile.fontSize,
      fontLigatures: currentProfile.fontLigatures,
    });
    setStatusMessage(t("terminal.defaultAppearanceSaved"));
  }, [setStatusMessage, t]);

  const saveCurrentProfileAsTerminalDefault = useCallback(async () => {
    const confirmed = await confirmTerminalDefaults({
      title: t("terminal.saveAllDefaultConfirmTitle"),
      message: t("terminal.saveAllDefaultConfirmMessage"),
      confirmLabel: t("terminal.saveAllDefaultConfirmButton"),
    });
    if (!confirmed) return;
    saveTerminalDefaultProfile(currentTerminalProfileRef.current);
    setStatusMessage(t("terminal.defaultProfileSaved"));
  }, [confirmTerminalDefaults, setStatusMessage, t]);

  const selectZmodemSendFiles = useCallback(async (): Promise<ZmodemSendFile[]> => {
    const filePaths = await selectUploadFile();
    if (!filePaths || filePaths.length === 0) return [];

    const files: ZmodemSendFile[] = [];
    for (const filePath of filePaths) {
      const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
      files.push({ name: fileName, path: filePath });
    }
    return files;
  }, []);

  const startZmodemSend = useCallback(async () => {
    if (!zmodemRef.current) {
      setStatusMessage("Terminal not ready for ZMODEM");
      return;
    }
    if (zmodemRef.current.isActive) {
      setStatusMessage("A ZMODEM transfer is already in progress");
      return;
    }
    try {
      const files = await selectZmodemSendFiles();
      if (files.length === 0) return;
      zmodemRef.current.queueSend(files);
      sendTerminalInput("rz\r");
      const names = files.map((f) => f.name).join(", ");
      setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "ZMODEM send failed");
    }
    focusTerminal();
  }, [focusTerminal, selectZmodemSendFiles, sendTerminalInput, setStatusMessage]);

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

  // Sends raw input to the terminal (and broadcasts when MultiExec is active)
  // WITHOUT running the pending-command tracker. Used by inline-suggestion
  // accept, which manages pending state explicitly.
  const sendUntrackedInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(data);
    }
    sendTerminalInput(data);
  }, [sendTerminalInput]);

  const acceptInlineSuggestion = useCallback((): boolean => {
    if (!suggestionsActiveRef.current) return false;
    const term = termRef.current;
    if (!term || term.buffer.active.type === "alternate") return false;
    const suggestion = suggestionRef.current;
    const pending = pendingRef.current;
    if (!suggestion || !pending || suggestion.length <= pending.length) return false;
    if (invalidatedRef.current) return false;
    if (!ghostVisibleRef.current) return false;

    const suffix = suggestion.slice(pending.length);
    if (suffix.length === 0) return false;

    sendUntrackedInput(suffix);

    pendingRef.current = suggestion;
    invalidatedRef.current = false;
    suggestionRef.current = null;
    refreshSuggestion();
    bumpGhost();
    return true;
  }, [sendUntrackedInput, refreshSuggestion, bumpGhost]);

  const extendTerminalBlockSelectionByKeyboard = useCallback((key: string) => {
    const term = termRef.current;
    if (!term) return false;
    const current = blockSelectionRef.current;
    const cursor = current?.focus ?? terminalCursorCell(term);
    if (!cursor) return false;

    const anchor = current?.anchor ?? cursor;
    const nextFocus: TerminalBlockSelectionCell = { ...cursor };
    if (key === "ArrowUp") nextFocus.row -= 1;
    if (key === "ArrowDown") nextFocus.row += 1;
    if (key === "ArrowLeft") nextFocus.col -= 1;
    if (key === "ArrowRight") nextFocus.col += 1;
    nextFocus.row = Math.max(0, Math.min(term.buffer.active.length - 1, nextFocus.row));
    nextFocus.col = Math.max(0, Math.min(term.cols - 1, nextFocus.col));

    term.clearSelection();
    const next = { anchor, focus: nextFocus };
    updateTerminalBlockSelection(next);
    showTerminalSelectionToolbar(collectTerminalBlockSelectionText(term, next));
    return true;
  }, [showTerminalSelectionToolbar, updateTerminalBlockSelection]);

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const effectiveReadOnly = readOnly || inputLocked;

  const handleShortcutKey = useCallback((event: KeyboardEvent): boolean => {
    if (isEditableTarget(event.target, document.activeElement)) {
      return true;
    }
    if (event.key === "F11") {
      event.preventDefault();
      setFullscreen((v) => !v);
      return false;
    }
    if (
      event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (extendTerminalBlockSelectionByKeyboard(event.key)) {
        event.preventDefault();
        return false;
      }
    }
    if (isMac && isMacPrintableOptionInput(event)) {
      event.preventDefault();
      writeBroadcastInput(event.key);
      return false;
    }
    if (event.key === "Escape" && blockSelectionRef.current) {
      event.preventDefault();
      clearTerminalBlockSelection();
      return false;
    }
    if (
      isLocal && supportsShellTools &&
      event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "p"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setPaletteOpen(true);
      return false;
    }
    // Ctrl+K: AI command rewrite overlay (v2.2)
    if (
      supportsShellTools && aiCommandRewriteEnabled && !isLocalPowerShell &&
      event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "k"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setAiRewriteOpen(true);
      return false;
    }
    // Cross-platform copy/paste shortcuts
    if (isMac) {
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
        if (getActiveTerminalSelectionText()) {
          event.preventDefault();
          void copySelection();
          return false;
        }
        return true; // no selection: pass through (sends ETX)
      }
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        if (!readOnlyRef.current) {
          // The desktop clipboard helper uses native IPC on macOS, so Cmd+V
          // does not depend on WKWebView synthesizing a paste event or prompt
          // for navigator.clipboard permission. Ignore a late native event to
          // keep the shortcut from inserting the same text twice.
          suppressNativePasteUntilRef.current = Date.now() + 500;
          void pasteFromClipboard();
        }
        return false;
      }
    } else {
      // Windows / Linux
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
        if (getActiveTerminalSelectionText()) {
          event.preventDefault();
          void copySelection();
          return false;
        }
        return true; // no selection: pass through
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "v") {
        if (!readOnlyRef.current) {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        return true;
      }
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
    if (
      gitToggle &&
      event.shiftKey &&
      event.key.toLowerCase() === "g" &&
      (isMac ? event.metaKey : event.ctrlKey) &&
      !event.altKey
    ) {
      event.preventDefault();
      gitToggle.onOpen();
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
    if (
      (event.key === "ArrowRight" || event.key === "End") &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    ) {
      if (acceptInlineSuggestion()) {
        event.preventDefault();
        return false;
      }
    }
    return true;
  }, [
    acceptInlineSuggestion,
    closeSearch,
    clearTerminalBlockSelection,
    decreaseFontSize,
    executeMacro,
    gitToggle,
    extendTerminalBlockSelectionByKeyboard,
    getActiveTerminalSelectionText,
    increaseFontSize,
    isLocal,
    isMac,
    openSearch,
    pasteFromClipboard,
    resetFontSize,
    saveBufferToFile,
    searchOpen,
    supportsShellTools,
    writeBroadcastInput,
  ]);

  const buildContextMenu = useCallback((): MenuItem[] => {
    const hasSelection = !!getActiveTerminalSelectionText();
    const copyShortcut = isMac ? "Cmd+C" : "Ctrl+Shift+C";
    const pasteShortcut = isMac ? "Cmd+V" : "Ctrl+Shift+V / Shift+Insert";
    const customTheme = isCustomTerminalTheme(themeName) ? resolveTerminalTheme(themeName) : null;
    const themeMenuValue = customTheme ? themeName : resolveThemeId(themeName);
    const themeOptions = buildTerminalThemeOptions({
      includeSystem: true,
      systemLabel: t("terminalAppearance.themeSystemName"),
      customValue: customTheme ? themeName : undefined,
      customTheme,
      customLabel: "Custom colors",
      darkGroup: "Dark",
      lightGroup: "Light",
    }).map((option) => ({
      ...option,
      testId: `terminal-context-theme-option-${option.value.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    }));

    return [
      { label: "Copy", shortcut: copyShortcut, onClick: () => void copySelection(), disabled: !hasSelection },
      { label: "Copy All", onClick: copyAll },
      { label: "Copy formatted text (HTML/RTF)", onClick: () => void copyFormattedSelection(), disabled: !hasSelection },
      { label: "Paste", shortcut: pasteShortcut, onClick: () => void pasteFromClipboard(), disabled: effectiveReadOnly },
      { label: "Find", shortcut: "Ctrl+Shift+F", onClick: openSearch },
      ...(gitToggle
        ? [
            { label: "", separator: true },
            {
              label: gitState.kind === "none" ? "Initialize Git Repository..." : "Open Git Panel",
              shortcut: isMac ? "Cmd+Shift+G" : "Ctrl+Shift+G",
              onClick: gitToggle.onOpen,
              disabled: !gitToggle.cwd,
            },
          ]
        : []),
      { label: "", separator: true },
      { label: "Zoom in", shortcut: "Ctrl++ / Ctrl+WheelUp", onClick: increaseFontSize },
      { label: "Zoom out", shortcut: "Ctrl+- / Ctrl+WheelDown", onClick: decreaseFontSize },
      { label: "Reset zoom", shortcut: "Ctrl+0", onClick: resetFontSize },
      {
        label: "Appearance",
        testId: "context-menu-item-appearance",
        customPanel: (
          <TerminalAppearanceMenuPanel
            themeValue={themeMenuValue}
            themeOptions={themeOptions}
            fontFamily={fontFamily}
            fontSize={fontSize}
            fontSelectTestId="terminal-context-font-select"
            fontSizeTestId="terminal-context-font-size"
            onChangeTheme={(nextTheme) => commitTerminalProfilePatch({ theme: nextTheme })}
            onChangeFontFamily={(nextFontFamily) => commitTerminalProfilePatch({ fontFamily: nextFontFamily })}
            onChangeFontSize={(nextFontSize) => commitTerminalProfilePatch({ fontSize: nextFontSize })}
          />
        ),
      },
      {
        label: t("terminal.contextSetAppearanceDefault"),
        testId: "terminal-context-set-local-default-theme",
        onClick: saveCurrentAppearanceAsTerminalDefault,
      },
      {
        label: t("terminal.contextSetProfileDefault"),
        testId: "terminal-context-set-local-default-profile",
        onClick: () => {
          void saveCurrentProfileAsTerminalDefault();
        },
      },
      {
        label: "Terminal display",
        children: [
          { label: "Reset terminal output", onClick: resetOutput },
          { label: "Clear terminal scrollback", onClick: clearScrollback },
          { label: "Set terminal title", onClick: renameTerminal, disabled: !tabId },
          {
            label: "Toggle terminal scrollbar",
            checked: showScrollbar,
            onClick: () => commitTerminalProfilePatch({ showScrollbar: !showScrollbar }),
          },
          { label: "Fullscreen terminal", shortcut: "F11", checked: fullscreen, onClick: () => setFullscreen((v) => !v) },
          {
            label: "Read-only terminal",
            checked: readOnly,
            onClick: () => commitTerminalProfilePatch({ readOnly: !readOnly }),
          },
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
      { label: "Send file using Z-modem", onClick: () => void startZmodemSend(), disabled: zmodemState !== "idle" },
      { label: "", separator: true },
      {
        label: t("terminal.contextChangeSettings"),
        testId: "terminal-context-change-settings",
        onClick: () => setSettingsDialogOpen(true),
      },
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
      { label: "", separator: true },
      {
        label: "AI: 解释最近的终端输出",
        onClick: () => {
          const term = termRef.current;
          if (!term) return;
          // Pull the last 50 lines from the buffer; if there's a selection,
          // prefer that. Both paths route to a fresh AI thread via
          // explainSelection (already redacts via chat::redact server-side).
          const selected = getActiveTerminalSelectionText();
          const text = selected && selected.trim()
            ? selected
            : getLastBufferLines(term, 50);
          if (text.trim().length === 0) {
            setStatusMessage("Terminal buffer is empty");
            return;
          }
          void useChatStore.getState().explainSelection(text);
        },
      },
    ];
  }, [
    clearScrollback,
    copyAll,
    copyFormattedSelection,
    copySelection,
    commitTerminalProfilePatch,
    decreaseFontSize,
    executeMacro,
    fontFamily,
    fontLigatures,
    fontSize,
    fullscreen,
    getActiveTerminalSelectionText,
    gitState.kind,
    gitToggle,
    increaseFontSize,
    isMac,
    openSearch,
    pasteFromClipboard,
    effectiveReadOnly,
    readOnly,
    renameTerminal,
    resetFontSize,
    resetOutput,
    saveBufferToFile,
    saveCurrentAppearanceAsTerminalDefault,
    saveCurrentProfileAsTerminalDefault,
    showScrollbar,
    setStatusMessage,
    syntaxMode,
    setSyntaxModeAndFocus,
    t,
    themeName,
    sendSpecialSignal,
    tabId,
    toggleMacroRecording,
    toggleOutputRecording,
    loggingActive,
    macroRecording,
    startZmodemSend,
    zmodemState,
  ]);

  useEffect(() => {
    if (!contextMenu.isOpen) return;
    contextMenu.refreshItems(buildContextMenu());
  }, [buildContextMenu, contextMenu.isOpen, contextMenu.refreshItems]);

  const handleTerminalContextMenu = useCallback((event: ReactMouseEvent) => {
    if (rightClickBehavior === "paste") {
      event.preventDefault();
      event.stopPropagation();
      void pasteFromClipboard();
      return;
    }

    if (rightClickBehavior === "copy-or-paste") {
      event.preventDefault();
      event.stopPropagation();
      if (getActiveTerminalSelectionText()) {
          void copySelection();
      } else {
        void pasteFromClipboard();
      }
      return;
    }

    contextMenu.show(event, buildContextMenu());
  }, [
    buildContextMenu,
    contextMenu,
    copySelection,
    getActiveTerminalSelectionText,
    pasteFromClipboard,
    rightClickBehavior,
  ]);

  const pasteMiddleClickSelectionOrClipboard = useCallback(() => {
    if (readOnlyRef.current) {
      middleClickSelectionRef.current = "";
      setStatusMessage("Terminal is read-only");
      return;
    }

    const selection = getActiveTerminalSelectionText() || middleClickSelectionRef.current;
    middleClickSelectionRef.current = "";
    if (selection) {
      writeBroadcastInput(formatPasteForTerminal(termRef.current, selection));
      focusTerminal();
      return;
    }
    void pasteFromClipboard();
  }, [focusTerminal, getActiveTerminalSelectionText, pasteFromClipboard, setStatusMessage, writeBroadcastInput]);

  const shouldHandleMacMiddlePaste = useCallback(() => {
    const now = Date.now();
    if (now - lastMacMiddlePasteAtRef.current < 250) return false;
    lastMacMiddlePasteAtRef.current = now;
    return true;
  }, []);

  const finishTerminalBlockSelection = useCallback((selection: TerminalBlockSelection | null) => {
    if (!selection) return;
    const term = termRef.current;
    if (!term) return;
    const text = blockSelectionTextRef.current || collectTerminalBlockSelectionText(term, selection);
    if (copyOnSelectRef.current && text) {
      void writeClipboardText(text, "");
    }
    showTerminalSelectionToolbar(text);
  }, [showTerminalSelectionToolbar, writeClipboardText]);

  const startTerminalBlockSelection = useCallback((event: ReactMouseEvent) => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return false;

    const anchor = terminalCellFromMouseEvent(term, container, event);
    if (!anchor) return false;

    event.preventDefault();
    event.stopPropagation();
    term.clearSelection();

    const initial = { anchor, focus: anchor };
    updateTerminalBlockSelection(initial);
    setSelectionToolbar(null);

    let latest = initial;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const focus = terminalCellFromMouseEvent(term, container, moveEvent);
      if (!focus) return;
      latest = { anchor, focus };
      updateTerminalBlockSelection(latest);
    };
    const onUp = (upEvent: globalThis.MouseEvent) => {
      const focus = terminalCellFromMouseEvent(term, container, upEvent);
      if (focus) {
        latest = { anchor, focus };
        updateTerminalBlockSelection(latest);
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      finishTerminalBlockSelection(latest);
      focusTerminal();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return true;
  }, [finishTerminalBlockSelection, focusTerminal, updateTerminalBlockSelection]);

  // Middle-click paste: if the terminal has a current selection, paste it at
  // the cursor; otherwise fall back to the system clipboard. Linux/Windows use
  // auxclick; macOS gets a mouseup capture fallback because WKWebView does not
  // consistently dispatch auxclick for the middle button.
  const handleMiddleClick = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (isMac && !shouldHandleMacMiddlePaste()) return;
    pasteMiddleClickSelectionOrClipboard();
  }, [isMac, pasteMiddleClickSelectionOrClipboard, shouldHandleMacMiddlePaste]);

  const handleTerminalMouseDownCapture = useCallback((event: ReactMouseEvent) => {
    if (event.button === 0) {
      const target = event.target;
      if (!(target instanceof Node) || !containerRef.current?.contains(target)) {
        return;
      }
      if (isTerminalBlockSelectionMouseEvent(event)) {
        startTerminalBlockSelection(event);
        return;
      }
      clearTerminalBlockSelection();
    }
    if (event.button === 1) {
      suppressNativePasteUntilRef.current = Date.now() + 500;
      middleClickSelectionRef.current = getActiveTerminalSelectionText();
    }
  }, [clearTerminalBlockSelection, getActiveTerminalSelectionText, startTerminalBlockSelection]);

  const handleTerminalMouseUpCapture = useCallback((event: ReactMouseEvent) => {
    if (!isMac || event.button !== 1) return;
    event.preventDefault();
    if (!shouldHandleMacMiddlePaste()) return;
    pasteMiddleClickSelectionOrClipboard();
  }, [isMac, pasteMiddleClickSelectionOrClipboard, shouldHandleMacMiddlePaste]);

  useEffect(() => {
    readOnlyRef.current = effectiveReadOnly;
  }, [effectiveReadOnly]);

  useEffect(() => {
    if (initialCwd) latestCwdRef.current = initialCwd;
  }, [initialCwd]);

  useEffect(() => {
    if (cwdRequestToken === 0 || cwdRequestToken === lastCwdRequestTokenRef.current) return;
    lastCwdRequestTokenRef.current = cwdRequestToken;
    requestTerminalCwd();
  }, [cwdRequestToken, requestTerminalCwd]);

  useEffect(() => {
    loggingActiveRef.current = loggingActive;
  }, [loggingActive]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    allowRemoteOsc52ClipboardRef.current = allowRemoteOsc52Clipboard;
  }, [allowRemoteOsc52Clipboard]);

  useEffect(() => {
    if (!terminalProfile) {
      appliedTerminalProfileSignatureRef.current = null;
      return;
    }

    const signature = terminalProfileSignature(terminalProfile);
    if (appliedTerminalProfileSignatureRef.current === signature) return;
    appliedTerminalProfileSignatureRef.current = signature;
    initialProfileRef.current = terminalProfile;
    currentTerminalProfileRef.current = terminalProfile;

    setFontFamily(terminalProfile.fontFamily);
    setFontSize(terminalProfile.fontSize);
    setFontLigatures(terminalProfile.fontLigatures);
    setShowScrollbar(terminalProfile.showScrollbar);
    setWebglRenderer(terminalProfile.webglRenderer);
    setReadOnly(terminalProfile.readOnly);
    setThemeName(terminalProfile.theme || theme);
    setCursorStyle(terminalProfile.cursorStyle);
    setCursorBlink(terminalProfile.cursorBlink);
    setScrollback(terminalProfile.scrollback);
    setSyntaxMode(terminalProfile.syntaxMode);
    setRightClickBehavior(terminalProfile.rightClickBehavior);
    setCopyOnSelect(terminalProfile.copyOnSelect);
    setAllowRemoteOsc52Clipboard(terminalProfile.allowRemoteOsc52Clipboard);
    setLoggingActive(terminalProfile.loggingEnabled);
    setMultilinePasteConfirm(terminalProfile.multilinePasteConfirm);
    setInlineSuggestionsEnabled(terminalProfile.inlineSuggestions);
    setInlineSuggestionsMax(terminalProfile.inlineSuggestionsMax);
    setInlineSuggestionsSource(terminalProfile.inlineSuggestionsSource);
    setAiCommandRewriteEnabled(terminalProfile.aiCommandRewriteEnabled);
    setCommonCommands(terminalProfile.commonCommands);
  }, [terminalProfile, theme]);

  useEffect(() => {
    macroRecordingRef.current = macroRecording;
  }, [macroRecording]);



  // Initialize once for the lifetime of this tab. Visibility changes must not
  // dispose the terminal, otherwise PTY/SSH sessions reconnect on tab switch.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || initializedRef.current) return;

    initializedRef.current = true;

    let destroyed = false;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenForwardError: UnlistenFn | null = null;
    let unlistenAuthPrompt: UnlistenFn | null = null;
    let detachImeGuard: (() => void) | null = null;
    let cleanupImePositionLock: (() => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let activityPromptTimer: ReturnType<typeof setTimeout> | undefined;
    let sockscapLaunchTimer: ReturnType<typeof setTimeout> | undefined;
    let launchedSockscapPid: number | null = null;

    const submitLocalDirectoryUse = (path: string) => {
      const backendSessionId = sessionIdRef.current;
      if (!backendSessionId) {
        pendingLocalDirectoryReportsRef.current.push(path);
        return;
      }
      recordLocalDirectoryUse({ backendSessionId, path }).catch(
        (error) => {
          console.warn("Local directory use record failed:", error);
        },
      );
    };

    const flushPendingLocalDirectoryReports = (backendSessionId: string) => {
      const pending = pendingLocalDirectoryReportsRef.current.splice(0);
      for (const path of pending) {
        recordLocalDirectoryUse({ backendSessionId, path }).catch(
          (error) => {
            console.warn("Local directory use record failed:", error);
          },
        );
      }
    };

    const primaryFont = getPrimaryFontName(fontFamily);
    const safeFontFamily = isMonospaceFont(primaryFont) ? fontFamily : getDefaultTerminalFontFamily();

    const term = new Terminal({
      theme: resolvePanelTheme(themeName),
      fontFamily: safeFontFamily,
      fontSize,
      cursorBlink,
      cursorStyle,
      scrollback,
      macOptionIsMeta: false,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (isTauriRuntime()) {
          tauriOpen(uri).catch((err) => {
            console.error("Failed to open terminal link in system browser:", err);
          });
        } else {
          const newWindow = window.open(uri, "_blank", "noopener,noreferrer");
          if (newWindow) {
            newWindow.opener = null;
          }
        }
      })
    );
    term.open(el);

    // Lock helper-textarea position during CJK IME composition to prevent candidate box jumping
    // when background text animations (e.g. Claude Code spinners) trigger cursor repositioning.
    const textarea = term.textarea;
    if (textarea) {
      let isComposing = false;
      let lockedLeft = "";
      let lockedTop = "";

      const onCompositionStart = () => {
        isComposingRef.current = true;
        isComposing = true;
        lockedLeft = textarea.style.left;
        lockedTop = textarea.style.top;
      };

      const onCompositionEnd = () => {
        isComposingRef.current = false;
        isComposing = false;
        // Flush any PTY output buffered during composition
        if (compositionBufferRef.current.length > 0) {
          for (const chunk of compositionBufferRef.current) {
            term.write(chunk);
          }
          compositionBufferRef.current = [];
        }
      };

      textarea.addEventListener("compositionstart", onCompositionStart);
      textarea.addEventListener("compositionend", onCompositionEnd);

      // macOS IME first-character fix. macOS IMEs (Sogou/Pinyin…) deliver committed text
      // via `input` (insertText) events but mark every keydown with keyCode 229, arriving
      // input → keydown → keyup. xterm's _keyDown sets `_keyDownSeen` for those, and its
      // _inputEvent then skips a composed character while the flag is set — so the first
      // char typed with a modifier held (e.g. the `@` from Shift+2) is dropped before it
      // reaches the PTY. Swallow keyCode-229 keydowns (capture phase, on the container so
      // it runs before xterm's textarea handler) so the flag is never set; the character
      // still arrives via `input`. Ctrl/Cmd combos pass through so shortcuts keep working.
      // (Linux uses its own guard above; see shouldSuppressMacImeKeydown for details.)
      const onMacImeKeydownCapture = (e: KeyboardEvent) => {
        if (isMac && shouldSuppressMacImeKeydown(e)) e.stopImmediatePropagation();
      };
      el.addEventListener("keydown", onMacImeKeydownCapture, true);

      // Refocus companion (see clearStaleKeyDownSeen): switching app/Space can drop a
      // modifier/arrow keyup on the other window, leaving xterm's `_keyDownSeen` stuck
      // true so the first digit/symbol typed on return is swallowed (letters, which go
      // through IME composition, are unaffected). Clear it whenever the terminal regains
      // focus — no key is actually held at that point.
      const onMacImeFocus = () => {
        if (isMac) clearStaleKeyDownSeen(term as unknown as { _core?: { _keyDownSeen?: boolean } });
      };
      textarea.addEventListener("focus", onMacImeFocus);

      // The textarea-focus reset above only fires when element focus actually
      // changes. A plain app/Space switch (Cmd+Tab, Ctrl+arrow) keeps the textarea
      // as document.activeElement, so it never re-fires `focus` on return and the
      // first digit/symbol is still swallowed (the stray gesture keyup was lost to
      // the window that took focus). The window's `focus` and the document's
      // `visibilitychange` DO fire for those switches — clear the stale flag from
      // there too, guarded to this terminal's textarea so other panes are untouched.
      const onMacImeWindowRefocus = () => {
        if (!isMac || document.visibilityState === "hidden") return;
        clearStaleKeyDownSeenIfActive(
          term as unknown as { textarea?: object | null; _core?: { _keyDownSeen?: boolean } },
          document.activeElement,
        );
      };
      window.addEventListener("focus", onMacImeWindowRefocus);
      document.addEventListener("visibilitychange", onMacImeWindowRefocus);

      const observer = new MutationObserver(() => {
        if (isComposing) {
          observer.disconnect();
          if (textarea.style.left !== lockedLeft) {
            textarea.style.left = lockedLeft;
          }
          if (textarea.style.top !== lockedTop) {
            textarea.style.top = lockedTop;
          }
          observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });
        }
      });

      observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });

      cleanupImePositionLock = () => {
        textarea.removeEventListener("compositionstart", onCompositionStart);
        textarea.removeEventListener("compositionend", onCompositionEnd);
        el.removeEventListener("keydown", onMacImeKeydownCapture, true);
        textarea.removeEventListener("focus", onMacImeFocus);
        window.removeEventListener("focus", onMacImeWindowRefocus);
        document.removeEventListener("visibilitychange", onMacImeWindowRefocus);
        observer.disconnect();
        compositionBufferRef.current = [];
      };
    }

    // OSC 7 — host writes its current working directory as `file://host/path`.
    // We listen for this so explicit SFTP "Sync" requests can learn the shell cwd.
    // For local shells we also record absolute path changes into command history
    // so Welcome "Recent folders" works even when the user `cd`s with a relative
    // path (history only stores the typed line, which may not be absolute).
    try {
      term.parser.registerOscHandler(7, (data) => {
        const cwd = parseOsc7(data);
        if (cwd) {
          latestCwdRef.current = cwd;
          cwdCallbackRef.current?.(cwd);
          if (tabId) {
            setTerminalRuntime(tabId, {
              state: "idle",
              program: undefined,
              activitySource: "shell-integration",
            });
          }
          if (isLocalRef.current) {
            const normalized = normalizeLocalStartCwd(cwd, getAppPlatform());
            if (
              normalized
              && normalized !== lastRecordedLocalDirRef.current
            ) {
              lastRecordedLocalDirRef.current = normalized;
              historyRef.current.commit(formatHistoryCdCommand(normalized));
              // Structured confirmed-use report (design §4.1.5): the backend
              // validates the live native-local runtime and dedups per
              // runtime; remote/WSL cwd never reaches this call because
              // normalizeLocalStartCwd returned null for it.
              submitLocalDirectoryUse(normalized);
            }
          }
        }
        return true;
      });
    } catch {
      /* parser API absent in some xterm builds */
    }

    // OSC 133 shell integration is emitted by a number of modern prompts.
    // `A` means prompt start (idle); `C` means command execution start. We do
    // not receive a safe executable name here, so retain any input-derived
    // program label and only improve the lifecycle state.
    try {
      term.parser.registerOscHandler(133, (data) => {
        if (!tabId) return true;
        const marker = data.trim().split(";")[0];
        if (marker === "A") {
          setTerminalRuntime(tabId, {
            state: "idle",
            program: undefined,
            activitySource: "shell-integration",
          });
        } else if (marker === "C") {
          setTerminalRuntime(tabId, {
            state: "running",
            activitySource: "shell-integration",
          });
        }
        return true;
      });
    } catch {
      /* parser API absent in some xterm builds */
    }

    try {
      term.parser.registerOscHandler(52, (data) => {
        const text = parseOsc52ClipboardText(data);
        if (text === null) return true;

        if (!isLocal && !allowRemoteOsc52ClipboardRef.current) {
          setStatusMessage("Remote OSC 52 clipboard is disabled");
          return true;
        }
        if (!text) return true;

        void clipboardWriteText(text)
          .then(() => setStatusMessage("Copied via OSC 52"))
          .catch((err) => {
            setStatusMessage(err instanceof Error ? err.message : "OSC 52 clipboard copy failed");
          });
        return true;
      });
    } catch {
      /* parser API absent in some xterm builds */
    }

    try {
      term.parser.registerOscHandler(633, (data) => {
        const match = /^TaomniTaskExit=(-?\d+)$/.exec(data.trim());
        if (match) onTaskExitRef.current?.(Number.parseInt(match[1], 10));
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

    installTerminalWebgl(term);

    fitVisibleTerminal();

    term.onData(writeXtermInput);
    term.onBinary(writeBinaryInput);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return handleShortcutKey(event);
    });
    const selectionDisposable = term.onSelectionChange(() => {
      if (blockSelectionRef.current) return;
      if (copyOnSelectRef.current && term.hasSelection()) {
        void writeClipboardText(term.getSelection(), "");
      }

      // SelectionToolbar: show when there is a non-empty selection that
      // contains useful content (ignore single-char accidental drags).
      if (term.hasSelection()) {
        const text = term.getSelection();
        showTerminalSelectionToolbar(text);
      } else {
        setSelectionToolbar(null);
      }
    });
    const scrollDisposable = term.onScroll(() => setViewportVersion((v) => v + 1));
    const renderDisposable = term.onRender(() => setViewportVersion((v) => v + 1));
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      setViewportVersion((v) => v + 1);
      appendEvent("resize", `${cols}x${rows}`);
      syncTerminalSize();
    });

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitVisibleTerminal();
      }, 100);
    });
    observer.observe(el);

    // Pin the xterm host container against IME-induced focus scrolling. When a
    // CJK IME composes, xterm moves its focused helper-textarea to the cursor
    // cell and grows it to the preedit width; if the cursor sits near the right
    // edge the caret lands past the viewport and the browser scrolls an ancestor
    // to reveal it, shoving the terminal off-screen (it snaps back on commit, so
    // it visibly oscillates). With `overflow:hidden` this container is now the
    // nearest scroll container, so the focus-scroll lands here — reset it to keep
    // the terminal fixed. The terminal's own scrollback lives on `.xterm-viewport`
    // (a different element), so this never touches the user's scroll position.
    // Guarded against the self-recursion of writing scrollLeft inside `scroll`.
    const onContainerScroll = () => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
      if (el.scrollTop !== 0) el.scrollTop = 0;
    };
    el.addEventListener("scroll", onContainerScroll, { passive: true });

    const adopted = adoptedTerminalRef.current;
    const sid =
      adopted?.sessionId ??
      sockscapTerminal?.terminalSessionId ??
      createTerminalSessionId();
    if (adopted?.snapshotText) {
      term.write(adopted.snapshotText.replace(/\n/g, "\r\n"));
    }

    // Create the ZMODEM sentry before invoking the backend. The raw output
    // channel can receive early SSH banners before create*Terminal resolves.
    const zmodem = new ZmodemSession(
      (bytes) => {
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
        const activeSid = sessionIdRef.current;
        if (!activeSid || connectionStateRef.current !== "connected") {
          return Promise.reject(new Error("Terminal is not connected"));
        }
        return writeTerminal(activeSid, btoa(b64)).catch((err) => {
          console.error(err);
          throw err;
        });
      },
      {
        onTerminalData: (data) => {
          if (destroyed) return;
          const suppressor = injectedInputEchoSuppressorRef.current;
          let filtered = suppressor ? suppressor.filter(data) : data;
          if (suppressor?.done) injectedInputEchoSuppressorRef.current = null;
          if (filtered.length === 0) return;
          if (loggingActiveRef.current) {
            outputLogRef.current += new TextDecoder().decode(filtered);
          }
          onOutputRef.current?.();
          if (isComposingRef.current) {
            compositionBufferRef.current.push(filtered);
          } else {
            term.write(filtered, () => {
              if (activityPromptTimer) clearTimeout(activityPromptTimer);
              activityPromptTimer = setTimeout(() => {
                if (
                  !destroyed &&
                  connectionStateRef.current === "connected" &&
                  terminalAtIdlePrompt(term)
                ) {
                  if (tabId) {
                    setTerminalRuntime(tabId, {
                      state: "idle",
                      program: undefined,
                      activitySource: "input-heuristic",
                    });
                  }
                  installSshCwdIntegrationRef.current?.();
                }
              }, 120);
            });
          }
        },
        onStateChange: (state, progress) => {
          setZmodemState(state);
          setZmodemProgress(progress ?? null);
        },
        onProgress: (progress) => {
          setZmodemProgress({ ...progress });
        },
        onSelectSaveDir: async () => {
          const dir = await selectSaveDirectory(zmodemSaveDirRef.current);
          if (dir) zmodemSaveDirRef.current = dir;
          return dir;
        },
        onSelectSendFiles: async () => {
          appendEvent("zmodem", "Remote rz requested local files");
          setStatusMessage("Remote rz detected; choose local files to send");
          const files = await selectZmodemSendFiles();
          if (files.length === 0) {
            appendEvent("zmodem", "Send canceled");
            setStatusMessage("ZMODEM send canceled");
            focusTerminal();
            return null;
          }
          const names = files.map((f) => f.name).join(", ");
          setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
          focusTerminal();
          return files;
        },
        onCheckFileExists: checkFileExists,
        onFileConflict: (fileName, hasMore) =>
          new Promise<ConflictAction>((resolve) => {
            setConflictDialogState({ fileName, hasMore, mode: "receive", resolve });
          }),
        onSendConflict: (fileName, hasMore) =>
          new Promise<SendConflictAction>((resolve) => {
            setConflictDialogState({
              fileName,
              hasMore,
              mode: "send",
              resolve: resolve as (action: ConflictAction | SendConflictAction) => void,
            });
          }),
        onOpenReadStream: readStreamOpen,
        onReadStream: readStreamRead,
        onCloseReadStream: readStreamClose,
        onOpenWriteStream: writeStreamOpen,
        onAppendWriteStream: writeStreamAppend,
        onCloseWriteStream: writeStreamClose,
        onAbortWriteStream: writeStreamAbort,
        onComplete: (fileName) => {
          appendEvent("zmodem", `Transfer complete: ${fileName}`);
          setStatusMessage(`ZMODEM: ${fileName} transferred`);
          window.setTimeout(focusTerminal, 0);
        },
        onError: (message) => {
          appendEvent("error", `ZMODEM error: ${message}`);
          setStatusMessage(`ZMODEM error: ${message}`);
          window.setTimeout(focusTerminal, 0);
        },
      },
    );

    const handleRawOutput = (raw: Uint8Array) => zmodem.consume(raw);

    type ConnectMode = "initial" | "reconnect";
    type ConnectResult = {
      sessionId: string;
      shellId: string | null;
      directoryUseWarning?: string | null;
    };

    const cancelPendingMfa = () => {
      if (pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(pendingMfaRequestIdRef.current, null).catch(() => {});
        pendingMfaRequestIdRef.current = null;
      }
      setMfaPrompt(null);
    };

    const clearConnectionListeners = () => {
      unlistenExit?.();
      unlistenExit = null;
      unlistenForwardError?.();
      unlistenForwardError = null;
      unlistenAuthPrompt?.();
      unlistenAuthPrompt = null;
    };

    const registerSshAuthPrompt = (targetSid: string) => {
      // SSH connections may demand a second factor (MFA/OTP) via
      // keyboard-interactive auth. Register before createSshTerminal, because
      // the backend emits prompts before that call resolves.
      void listenSshAuthPrompt(targetSid, (payload) => {
        if (destroyed) {
          // Window/panel gone — cancel so the backend stops waiting.
          void submitSshAuthResponse(payload.requestId, null).catch(() => {});
          return;
        }
        pendingMfaRequestIdRef.current = payload.requestId;
        setMfaPrompt(payload);
      })
        .then((un) => {
          if (destroyed) {
            un();
          } else {
            unlistenAuthPrompt = un;
          }
        })
        .catch(() => {
          /* listener registration failed — connect proceeds; if the server
             demands MFA it'll fail with a clear auth error. */
        });
    };

    const markDisconnected = (endedSid: string) => {
      if (sessionIdRef.current !== endedSid) return;

      if (sockscapTerminal) {
        void closeTerminal(endedSid).catch(() => {});
      }

      clearConnectionListeners();
      connectionStateRef.current = "disconnected";
      sessionIdRef.current = null;
      setRegisteredSessionId(null);
      zmodemRef.current = null;
      pendingRef.current = "";
      invalidatedRef.current = false;
      suggestionRef.current = null;
      bumpGhost();
      refreshSuggestion();
      if (tabId) {
        setTerminalRuntime(tabId, {
          state: "disconnected",
          program: undefined,
          backendSessionId: undefined,
        });
      }
      onDetachedStateChangeRef.current?.({ snapshotText: getBufferText(term) });

      appendEvent("disconnect", "Terminal session ended");
      if (loggingActiveRef.current && outputLogRef.current) {
        flushRecordedOutput("Session ended; saved recorded output");
      }

      if (ssh && !adopted) {
        term.write("\r\n\x1b[33m[SSH disconnected] Press Enter to reconnect.\x1b[0m\r\n");
        setStatusMessage("SSH disconnected; press Enter to reconnect");
        window.setTimeout(focusTerminal, 0);
      } else {
        term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
      }
    };

    const handleConnected = async (
      { sessionId: connectedSid, shellId, directoryUseWarning }: ConnectResult,
      mode: ConnectMode,
    ) => {
      if (destroyed) {
        const detachPending = tabId ? consumeTerminalDetachPending(tabId) : false;
        // Adopted panels never own the backend session — don't close it on
        // unmount even if it appears we were the only mount. The original
        // detacher / reattacher owns lifecycle.
        if (preserveSessionOnUnmountRef.current || detachPending || adopted) {
          onDetachedStateChangeRef.current?.({ terminalSessionId: connectedSid });
        } else {
          closeTerminal(connectedSid).catch(() => {});
        }
        return;
      }

      connectionStateRef.current = "connected";
      sessionIdRef.current = connectedSid;
      if (isLocalRef.current) flushPendingLocalDirectoryReports(connectedSid);
      lastTerminalSizeSyncRef.current = null;
      setRegisteredSessionId(connectedSid);
      if (tabId) {
        setTerminalRuntime(tabId, {
          backendSessionId: connectedSid,
          state: "unknown",
          program: undefined,
        });
      }
      zmodemRef.current = zmodem;
      if (shellId) setResolvedLocalShellId(shellId);
      pendingMfaRequestIdRef.current = null;
      setMfaPrompt(null);
      onSessionReadyRef.current?.(connectedSid);
      if (directoryUseWarning) {
        appendEvent("error", directoryUseWarning);
        setStatusMessage(directoryUseWarning);
      }
      onDetachedStateChangeRef.current?.({ terminalSessionId: connectedSid });
      appendEvent(
        "connection",
        `${adopted ? "Reattached" : mode === "reconnect" ? "Reconnected" : "Connected"} (${connectedSid})`,
      );
      scheduleTerminalFitAndSync(true);
      // Install continuous OSC 7 cwd reporting by writing a one-shot setup
      // command into the shell, but only once it shows a real, idle prompt —
      // never into a blank/initializing shell (a slow rc / conda init), a
      // streaming MOTD, or a half-typed line. Injecting early is what leaked the
      // raw command: the input got buffered, the echo came back after the
      // suppressor's TTL, and the whole line printed. Poll for the prompt over
      // several seconds; if login init or a startup command outlives that window,
      // retain an event-driven installer that runs when output later settles at
      // an idle prompt. The terminal is usable immediately; this only defers the
      // background hook. Shared by the SSH remote shell and the local macOS zsh.
      const scheduleCwdIntegrationInstall = (targetSid: string, integrationCommand: string) => {
        let integrationAttempts = 0;
        let integrationInstalling = false;
        const MAX_INTEGRATION_ATTEMPTS = 12; // ~6s of polling for a slow login
        const installCwdIntegration = (): boolean => {
          if (destroyed || sessionIdRef.current !== targetSid) {
            if (installSshCwdIntegrationRef.current === installCwdIntegration) {
              installSshCwdIntegrationRef.current = null;
            }
            return false;
          }
          if (integrationInstalling) return true;
          const liveTerm = termRef.current;
          if (!liveTerm || !terminalAtIdlePrompt(liveTerm)) return false;
          integrationInstalling = true;
          if (installSshCwdIntegrationRef.current === installCwdIntegration) {
            installSshCwdIntegrationRef.current = null;
          }
          // Generous TTL so a laggy link's echo round-trip still arrives while
          // the suppressor is dropping (we only get here at a ready prompt, so
          // it's just network latency, not shell startup). Bounded so a
          // non-POSIX shell — which never emits the OSC 7 — isn't blacked out
          // for too long before output resumes.
          injectedInputEchoSuppressorRef.current = createOsc7BlankingSuppressor(4000);
          writeTerminal(targetSid, encodeBase64(`${integrationCommand}\r`)).catch(() => {
            if (sessionIdRef.current === targetSid) {
              integrationInstalling = false;
              installSshCwdIntegrationRef.current = installCwdIntegration;
              injectedInputEchoSuppressorRef.current = null;
            }
          });
          return true;
        };
        installSshCwdIntegrationRef.current = installCwdIntegration;
        const pollForCwdIntegration = () => {
          if (installCwdIntegration()) return;
          if (destroyed || sessionIdRef.current !== targetSid) return;
          if (integrationAttempts < MAX_INTEGRATION_ATTEMPTS) {
            integrationAttempts += 1;
            window.setTimeout(pollForCwdIntegration, 500);
          }
        };
        window.setTimeout(pollForCwdIntegration, 500);
      };
      if (ssh && !adopted) {
        if (mode === "reconnect") {
          term.write(`\r\n\x1b[32m[Reconnected to ${ssh.username}@${ssh.host}:${ssh.port}]\x1b[0m\r\n`);
          setStatusMessage("SSH reconnected");
          window.setTimeout(focusTerminal, 0);
          window.dispatchEvent(
            new CustomEvent("taomni:terminal-reconnected", {
              detail: { tabId },
            }),
          );
        } else {
          term.write(formatSshInfoBanner(ssh));
        }
        // Install continuous OSC 7 cwd reporting on the remote shell so the tab
        // always knows its working directory — used by SFTP "Sync" and, crucially,
        // by tab duplication (which reads the last-known cwd instead of probing
        // the source terminal, so there's no echo to hide and no half-typed input
        // line to corrupt). When this tab is itself a duplicate carrying the
        // source's cwd, the setup cd's there first (SSH can't set a start dir).
        // Best-effort POSIX (bash/zsh); a non-POSIX remote just errors on the
        // line, which the blanking suppressor hides up to its TTL.
        scheduleCwdIntegrationInstall(connectedSid, buildSshCwdIntegration(initialCwd));
      } else if (
        !commandTerminal &&
        !adopted &&
        getAppPlatform() === "macos"
      ) {
        // macOS-only: the default local shell is zsh, and the backend's
        // shell_integration.rs installs a bash `PROMPT_COMMAND` that zsh
        // ignores — so a local zsh never reports its cwd and tab-duplication /
        // the git panel have nothing to work with. Inject a zsh `precmd_functions`
        // hook the same way the SSH path does. No-op on bash (already covered by
        // the backend `PROMPT_COMMAND`). Linux/Windows locals are left untouched.
        scheduleCwdIntegrationInstall(connectedSid, buildLocalZshCwdIntegration());
      }

      unlistenExit = await listenTerminalExit(connectedSid, () => markDisconnected(connectedSid));

      // Surface per-row local-forward errors (parse, bind, accept,
      // direct-tcpip open) in the same event log the user already sees
      // for connection / auth / disconnect events. Also re-broadcast
      // as a window-level CustomEvent keyed by the persisted session
      // config id so an open SessionEditor can show the failure
      // inline next to the offending forward row.
      unlistenForwardError = await listenTerminalForwardError(connectedSid, (err) => {
        appendEvent(
          "error",
          `Local forward ${err.local} → ${err.remote}: ${err.message}`,
        );
        if (ssh?.sessionId) {
          window.dispatchEvent(
            new CustomEvent("taomni:forward-error", {
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
    };

    const handleConnectFailure = (err: unknown, mode: ConnectMode) => {
      if (destroyed) return;
      console.error("Failed to create terminal:", err);
      onSessionLaunchFailedRef.current?.(err);
      cancelPendingMfa();
      connectionStateRef.current = ssh ? "disconnected" : "idle";
      sessionIdRef.current = null;
      pendingLocalDirectoryReportsRef.current = [];
      setRegisteredSessionId(null);
      zmodemRef.current = null;
      const message = String(err);
      if (tabId) {
        setTerminalRuntime(tabId, {
          state: "disconnected",
          program: undefined,
          backendSessionId: undefined,
        });
      }
      const label = ssh && mode === "reconnect" ? "Reconnect failed" : "Connection failed";
      appendEvent("error", `${label}: ${message}`);
      if (ssh && !adopted) {
        term.write(`\r\n\x1b[31m[${label}] ${message}\x1b[0m\r\n\x1b[33mPress Enter to retry.\x1b[0m\r\n`);
        setStatusMessage(`${label}; press Enter to retry`);
        window.setTimeout(focusTerminal, 0);
      } else {
        term.write(`\x1b[31m${label}: ${message}\x1b[0m\r\n`);
      }
    };

    const startSshConnection = (targetSid: string, mode: ConnectMode) => {
      if (!ssh || adopted || destroyed) return;

      clearConnectionListeners();
      cancelPendingMfa();
      connectionStateRef.current = mode === "reconnect" ? "reconnecting" : "connecting";
      if (tabId) setTerminalRuntime(tabId, { state: "connecting", program: undefined });
      sessionIdRef.current = null;
      setRegisteredSessionId(null);
      zmodemRef.current = null;
      registerSshAuthPrompt(targetSid);

      appendEvent(
        "connection",
        `${mode === "reconnect" ? "Reconnecting" : "Connecting"} to ${ssh.username}@${ssh.host}:${ssh.port}`,
      );
      appendEvent("auth", `Using ${ssh.authMethod} authentication`);
      if (mode === "reconnect") {
        term.write(`\r\n\x1b[33m[Reconnecting to ${ssh.username}@${ssh.host}:${ssh.port}...]\x1b[0m\r\n`);
        setStatusMessage("Reconnecting SSH terminal");
      } else {
        term.write(`\x1b[33mConnecting to ${ssh.username}@${ssh.host}:${ssh.port}...\x1b[0m\r\n`);
      }

      fitVisibleTerminal();
      const { cols, rows } = currentTerminalSize(term);

      const ns = getSessionNetworkSettings(ssh.optionsJson);
      const opts = parseSessionOptions(ssh.optionsJson);
      const startupCommand = typeof opts.startupCmd === "string" ? opts.startupCmd.trim() : "";
      createSshTerminal(
        targetSid,
        ssh.host,
        ssh.port,
        ssh.username,
        ssh.authMethod,
        ssh.authData,
        cols,
        rows,
        JSON.stringify(toNetworkSettingsPayload(ns)),
        handleRawOutput,
        // X11 forwarding: enabled per-session (defaults on, matching the
        // SessionEditor default). Trusted mode unless the expert option
        // explicitly opts into untrusted.
        opts.x11 !== false,
        opts.x11Trusted !== false,
        startupCommand || null,
        startupCommand ? opts.doNotExit !== false : false,
      )
        .then((sessionId) => handleConnected({ sessionId, shellId: null }, mode))
        .catch((err) => handleConnectFailure(err, mode));
    };

    const startCommandTerminal = (targetSid: string) => {
      if (!commandTerminal || adopted || destroyed) return;

      clearConnectionListeners();
      connectionStateRef.current = "connecting";
      if (tabId) setTerminalRuntime(tabId, { state: "connecting", program: undefined });
      sessionIdRef.current = null;
      setRegisteredSessionId(null);
      zmodemRef.current = null;

      const endpoint = commandTerminal.kind === "Serial"
        ? commandTerminal.host
        : `${commandTerminal.username ? `${commandTerminal.username}@` : ""}${commandTerminal.host}${
            commandTerminal.port > 0 ? `:${commandTerminal.port}` : ""
          }`;
      appendEvent("connection", `Starting ${commandTerminal.kind} client for ${endpoint}`);
      term.write(`\x1b[33mStarting ${commandTerminal.kind} client for ${endpoint}...\x1b[0m\r\n`);

      fitVisibleTerminal();
      const { cols, rows } = currentTerminalSize(term);

      createCommandTerminal(
        targetSid,
        commandTerminal.kind,
        commandTerminal.host,
        commandTerminal.port,
        commandTerminal.username,
        commandTerminal.optionsJson ?? null,
        cols,
        rows,
        handleRawOutput,
      )
        .then((sessionId) => handleConnected({ sessionId, shellId: null }, "initial"))
        .catch((err) => handleConnectFailure(err, "initial"));
    };

    reconnectSshRef.current = () => {
      if (!ssh || adopted || destroyed) return;
      if (connectionStateRef.current !== "disconnected") return;
      startSshConnection(createTerminalSessionId(), "reconnect");
    };

    if (adopted) {
      connectionStateRef.current = "connecting";
      appendEvent("connection", `Reattaching terminal ${sid}`);
      attachTerminalOutput(sid, handleRawOutput)
        .then(() => handleConnected({ sessionId: sid, shellId: null }, "initial"))
        .catch((err) => handleConnectFailure(err, "initial"));
    } else if (ssh) {
      startSshConnection(sid, "initial");
    } else if (commandTerminal) {
      startCommandTerminal(sid);
    } else if (sockscapTerminal) {
      connectionStateRef.current = "connecting";
      appendEvent("connection", `Starting ${sockscapTerminal.path} through SocksCap`);
      term.write(
        `\x1b[33mStarting ${sockscapTerminal.path} through SocksCap...\x1b[0m\r\n`,
      );
      fitVisibleTerminal();
      const { cols, rows } = currentTerminalSize(term);
      // React StrictMode intentionally runs mount effects twice in development.
      // Defer the irreversible backend launch so the first setup can be
      // cancelled by its immediate cleanup instead of spawning two commands.
      sockscapLaunchTimer = window.setTimeout(() => {
        if (destroyed) return;
        sockscapLaunchTerminalApp(
          sid,
          sockscapTerminal.profileId,
          sockscapTerminal.path,
          sockscapTerminal.args,
          sockscapTerminal.launchPreparation ?? {},
          cols,
          rows,
          handleRawOutput,
        )
          .then((launched) => {
            if (destroyed) {
              void closeTerminal(sid).catch(() => {});
              void sockscapStopLaunchedApp(launched.pid).catch(() => {});
              return;
            }
            launchedSockscapPid = launched.pid;
            return handleConnected({ sessionId: sid, shellId: null }, "initial");
          })
          .catch((err) => {
            if (!destroyed) handleConnectFailure(err, "initial");
          });
      }, 0);
    } else {
      connectionStateRef.current = "connecting";
      appendEvent("connection", `Starting ${localShell?.name ?? "local terminal"}`);
      fitVisibleTerminal();
      const { cols, rows } = currentTerminalSize(term);
      // A duplicated terminal carries the source's cwd (from OSC 7). Translate
      // it into a native start directory; skip it if it can't be mapped (e.g. a
      // WSL/MSYS path with no Windows drive) so the shell still launches.
      const startCwd = initialCwd
        ? normalizeLocalStartCwd(initialCwd, getAppPlatform()) ?? undefined
        : undefined;
      createLocalTerminal(
        sid,
        cols,
        rows,
        localShell?.id,
        localShell?.args,
        startCwd,
        handleRawOutput,
        workspaceRootRef.current,
      )
        .then(({ sessionId, shellId, directoryUseWarning }) =>
          handleConnected({ sessionId, shellId, directoryUseWarning }, "initial"),
        )
        .catch((err) => handleConnectFailure(err, "initial"));
    }

    return () => {
      destroyed = true;
      observer.disconnect();
      el.removeEventListener("scroll", onContainerScroll);
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      clearTimeout(resizeTimer);
      if (activityPromptTimer) clearTimeout(activityPromptTimer);
      if (sockscapLaunchTimer) clearTimeout(sockscapLaunchTimer);
      installSshCwdIntegrationRef.current = null;
      unlistenExit?.();
      unlistenForwardError?.();
      unlistenAuthPrompt?.();
      // Cancel any MFA prompt still awaiting an answer so the backend's auth
      // task stops blocking and tears the half-open connection down.
      if (pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(pendingMfaRequestIdRef.current, null).catch(() => {});
        pendingMfaRequestIdRef.current = null;
      }
      detachImeGuard?.();
      cleanupImePositionLock?.();
      if (loggingActiveRef.current && outputLogRef.current) {
        flushRecordedOutput("Terminal closed; saved recorded output");
      }
      if (sessionIdRef.current && !preserveSessionOnUnmountRef.current) {
        const detachPending = tabId ? consumeTerminalDetachPending(tabId) : false;
        // Adopted sessions are owned by whoever originally created them —
        // don't close on unmount, even when StrictMode double-mounts.
        if (!detachPending && !adopted) {
          closeTerminal(sessionIdRef.current).catch(() => {});
        }
      }
      if (launchedSockscapPid !== null) {
        void sockscapStopLaunchedApp(launchedSockscapPid).catch(() => {});
      }
      term.dispose();
      webglAddonRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      sessionIdRef.current = null;
      pendingLocalDirectoryReportsRef.current = [];
      connectionStateRef.current = "idle";
      reconnectSshRef.current = null;
      setRegisteredSessionId(null);
      zmodemRef.current = null;
      imeGuardRef.current = null;
      initializedRef.current = false;
    };
  }, []);

  useEffect(() => {
    webglRendererRef.current = webglRenderer;
    const term = termRef.current;
    if (!term) return;

    if (!shouldUseTerminalWebgl(webglRenderer)) {
      disposeTerminalWebgl(term);
      return;
    }
    installTerminalWebgl(term);
  }, [disposeTerminalWebgl, installTerminalWebgl, webglRenderer]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const primaryFont = getPrimaryFontName(fontFamily);
    const safeFontFamily = isMonospaceFont(primaryFont) ? fontFamily : getDefaultTerminalFontFamily();

    term.options = {
      fontFamily: safeFontFamily,
      fontSize,
      theme: resolvePanelTheme(themeName),
      cursorBlink,
      cursorStyle,
      scrollback,
      macOptionIsMeta: false,
    };
    window.setTimeout(() => requestAnimationFrame(() => fitVisibleTerminal()), 0);
  }, [cursorBlink, cursorStyle, fitVisibleTerminal, fontFamily, fontSize, resolvePanelTheme, scrollback, themeName]);

  // When a hidden tab becomes visible again, re-measure xterm. Focus is
  // reserved for the active pane so split view does not race visible panes.
  useEffect(() => {
    if (!visible) return;

    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        fitVisibleTerminal();
        if (activeForShortcuts && !searchOpen) {
          focusTerminal();
        }
      });
    }, 50);

    return () => {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeForShortcuts, fitVisibleTerminal, focusTerminal, fullscreen, searchOpen, showScrollbar, visible]);

  useEffect(() => {
    if (!activeForShortcuts) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(event.target, activeEl)) {
        return;
      }
      if (!isTerminalFocused(panelRef.current, activeEl)) {
        return;
      }

      if (handleShortcutKey(event) === false) {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeForShortcuts, handleShortcutKey]);

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

  // Own macOS native paste events instead of letting xterm.js handle them. The event
  // carries clipboardData for user-triggered paste (Cmd+V / menu Paste) without
  // invoking navigator.clipboard.readText(), so macOS WKWebView does not show
  // the native "Paste" confirmation popover. Capturing on the xterm container
  // keeps this scoped away from sibling inputs like the find bar.
  //
  // On Windows / Linux, preserve the previous behavior: suppress native paste
  // events and use the explicit terminal paste shortcuts/menu paths instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPaste = (event: ClipboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!isMac) {
        return;
      }
      if (Date.now() < suppressNativePasteUntilRef.current) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!isLocal && onUploadLocalPathsRef.current) {
        void clipboardReadFiles()
          .then((paths) => {
            if (paths.length > 0) {
              return handleLocalFilePaths(paths);
            }
            void pasteTextIntoTerminal(text);
            return undefined;
          })
          .catch((err) => {
            setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
          });
        return;
      }
      void pasteTextIntoTerminal(text);
    };
    el.addEventListener("paste", onPaste, { capture: true });
    return () => el.removeEventListener("paste", onPaste, { capture: true });
  }, [handleLocalFilePaths, isLocal, isMac, pasteTextIntoTerminal, setStatusMessage]);

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

  const blockSelectionHighlights = useMemo(
    () => getVisibleTerminalBlockSelectionHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      blockSelection,
    ),
    [blockSelection, fontSize, fullscreen, showScrollbar, viewportVersion],
  );

  const inlineGhost = useMemo(
    () => computeInlineGhost(
      termRef.current,
      panelRef.current,
      containerRef.current,
      suggestionsActive,
      pendingRef.current,
      suggestionRef.current,
      invalidatedRef.current,
    ),
    // ghostTick bumps on pending/suggestion changes; viewportVersion on scroll/render.
    // fontSize/fullscreen/showScrollbar also force recompute on layout shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ghostTick, viewportVersion, suggestionsActive, fontSize, fullscreen, showScrollbar],
  );

  useEffect(() => {
    ghostVisibleRef.current = inlineGhost !== null;
  }, [inlineGhost]);

  const panelClasses = [
    "relative w-full h-full",
    fullscreen ? "fixed inset-0 z-[9000]" : "",
    showScrollbar ? "" : "terminal-hide-scrollbar",
    fontLigatures ? "terminal-font-ligatures" : "terminal-no-font-ligatures",
  ].filter(Boolean).join(" ");
  const resolvedTheme = resolvePanelTheme(themeName);
  // Latest theme/font for capture, read lazily so the registration effect below
  // doesn't churn on every render (resolvedTheme is a fresh object each time).
  const captureThemeRef = useRef({ resolvedTheme, fontFamily, fontSize });
  captureThemeRef.current = { resolvedTheme, fontFamily, fontSize };

  // Keep data-terminal-text in sync so WebDriver / automation can read
  // terminal content without depending on xterm's canvas rendering.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const update = () => {
      const term = termRef.current;
      el.setAttribute("data-terminal-text", term ? getBufferText(term) : "");
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, []);

  // Register this terminal in the global registry so the AI Chat Drawer can
  // pull buffer context (`@terminal:last-N`) and push commands back into it
  // (the assistant's "Send to terminal" button on rendered code blocks).
  // Re-runs whenever the backend session id changes, since stale entries
  // would point at a closed pty.
  useEffect(() => {
    if (!tabId || !registeredSessionId) return;
    const unregister = registerTerminal({
      tabId,
      sessionId: registeredSessionId,
      title: tabTitle,
      localEnvironment: isLocal
        ? {
            platform: getAppPlatform(),
            shellId: resolvedLocalShellId ?? localShell?.id ?? null,
            shellName: localShell?.name ?? null,
            shellArgs: localShell?.args ?? [],
          }
        : null,
      getBufferText: () => {
        const t = termRef.current;
        return t ? getBufferText(t) : "";
      },
      getLastLines: (n: number) => {
        const t = termRef.current;
        return t ? getLastBufferLines(t, n) : "";
      },
      writeInput: (data: string) => {
        if (readOnlyRef.current) return;
        if (/[\r\n]/.test(data)) {
          const program = inferTerminalProgram(data.split(/[\r\n]/).find((line) => line.trim()) ?? "");
          if (program) {
            setTerminalRuntime(tabId, {
              state: "running",
              program,
              activitySource: "input-heuristic",
            });
          }
        }
        writeTerminal(registeredSessionId, encodeBase64(data)).catch(console.error);
      },
      runTask: (command: string, taskVariables) => {
        if (readOnlyRef.current) return;
        const task = renderTerminalTask(command, {
          platform: getAppPlatform(),
          shellId: resolvedLocalShellId ?? localShell?.id ?? null,
          shellName: localShell?.name ?? null,
        }, taskVariables);
        const suppressor = createTaskStartOutputSuppressor(
          task.startMarker,
          task.displayCommand,
        );
        injectedInputEchoSuppressorRef.current = suppressor;
        const program = inferTerminalProgram(task.displayCommand);
        setTerminalRuntime(tabId, {
          state: "running",
          program: program ?? undefined,
          activitySource: "input-heuristic",
        });
        writeTerminal(
          registeredSessionId,
          encodeBase64(buildInteractiveCommandInput(task.input)),
        ).catch((err) => {
          if (injectedInputEchoSuppressorRef.current === suppressor) {
            injectedInputEchoSuppressorRef.current = null;
          }
          console.error(err);
        });
      },
      // Display-only echo (xterm.write): mirror Claude Code's captured-run
      // activity into this terminal as a read-only trace. Intentionally NOT
      // gated by readOnlyRef — it never reaches stdin, it only paints the
      // screen, so a read-only/locked session can still show what CC ran.
      writeEcho: (data: string) => {
        termRef.current?.write(data);
      },
    });
    // Mirror the tab → backend-session mapping to the backend so Claude Code's
    // server-side tools (run_captured / read_capture) can resolve this live
    // terminal by tab id — run_in_terminal reaches it via the frontend registry
    // above, but those tools index state.terminals directly. Best-effort; a miss
    // just degrades to the existing "no live terminal" behaviour.
    void ccTrackTerminal(tabId, registeredSessionId).catch(() => {});
    return () => {
      unregister();
      void ccUntrackTerminal(tabId, registeredSessionId).catch(() => {});
    };
  }, [isLocal, localShell?.args, localShell?.id, localShell?.name, resolvedLocalShellId, setTerminalRuntime, tabId, registeredSessionId, tabTitle]);

  // Publish this terminal's capture source while it's the active tab, so the
  // screenshot actions (folded into the tab-strip `⋯` menu in the main window,
  // or the capture button in a detached window) target its rendered content.
  useEffect(() => {
    if (!activeForShortcuts) return;
    const themeOf = (): XtermCaptureTheme => {
      const { resolvedTheme: rt, fontFamily: ff, fontSize: fs } = captureThemeRef.current;
      return {
        background: rt.background ?? "#1d1f21",
        foreground: rt.foreground ?? "#eaeaea",
        fontFamily: ff,
        fontSize: fs,
        lineHeight: 1.2,
      };
    };
    const source: CaptureSource = {
      filenamePrefix: tabTitle,
      getVisible: async () => {
        const term = termRef.current;
        const container = containerRef.current;
        if (!term) throw new Error("Terminal not ready");
        try {
          return await captureXtermVisible(term, themeOf());
        } catch (err) {
          if (container) return await captureContainerCanvasesPng(container);
          throw err;
        }
      },
      getFull: async () => {
        const term = termRef.current;
        if (!term) throw new Error("Terminal not ready");
        return await captureXtermFullBuffer(term, themeOf());
      },
      getScrollFrame: () => {
        const term = termRef.current;
        return term ? renderXtermVisibleToCanvas(term, themeOf()) : null;
      },
      getGifFrame: () => {
        const term = termRef.current;
        return term ? renderXtermVisibleToCanvas(term, themeOf()) : null;
      },
      onStatus: (msg) => setStatusMessage(msg),
    };
    useCaptureStore.getState().setSource(source);
    return () => useCaptureStore.getState().clearSource(source);
  }, [activeForShortcuts, tabTitle, setStatusMessage]);

  return (
    <div
      ref={panelRef}
      data-testid="terminal-pane"
      data-input-locked={inputLocked || undefined}
      className={panelClasses}
      style={{
        background: resolvedTheme.background ?? "#1d1f21",
        ...(isMultiExecTarget ? { borderTop: "2px solid var(--taomni-accent)" } : {}),
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (event.deltaY < 0) {
          increaseFontSize();
        } else if (event.deltaY > 0) {
          decreaseFontSize();
        }
      }}
      onDragOver={handleTerminalDragOver}
      onDrop={handleTerminalDrop}
      onContextMenu={handleTerminalContextMenu}
      onMouseDownCapture={handleTerminalMouseDownCapture}
      onMouseUpCapture={handleTerminalMouseUpCapture}
      onAuxClick={handleMiddleClick}
    >
      <div ref={containerRef} className="w-full h-full overflow-hidden" />

      <TabActions active={activeForShortcuts}>
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
            title={sftpToggle.open ? t("terminal.sftpFloatingClose") : t("terminal.sftpFloatingOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(sftpToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <FolderOpen size={14} />
            {t("terminal.sftpFloatingButtonLabel")}
          </button>
        )}
        {chatToggle && (
          <button
            type="button"
            data-testid="tab-chat-toggle"
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
            {t("terminal.chatFloatingButtonLabel")}
          </button>
        )}
        {detachToggle && (
          <button
            type="button"
            data-testid="terminal-detach"
            aria-label={t("rdp.detach")}
            title={t("rdp.detach")}
            onClick={detachToggle.onDetach}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {detachedWindowControls && (
          <>
            <CaptureMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              aria-label={t("rdp.reattach")}
              title={t("rdp.reattach")}
              onClick={() => {
                preserveSessionOnUnmountRef.current = true;
                detachedWindowControls.onReattach(collectReattachState());
              }}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              aria-label={t("rdp.osFullscreen")}
              title={t("rdp.osFullscreen")}
              onClick={detachedWindowControls.onToggleOsFullscreen}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </TabActions>

      {isMultiExecTarget && (
        <div
          className="absolute top-1 left-1 z-40 px-1.5 py-0.5 rounded pointer-events-none"
          style={{ background: "var(--taomni-accent)", color: "#fff", opacity: 0.85, fontSize: 10, fontWeight: 600 }}
        >
          ⊕ {t("terminal.multiExecBadge")}
        </div>
      )}

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

      {blockSelectionHighlights.length > 0 && (
        <div className="absolute inset-0 z-[35] pointer-events-none">
          {blockSelectionHighlights.map((highlight) => (
            <div
              key={`block-${highlight.row}`}
              className="terminal-block-selection"
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

      {inlineGhost && (
        <div
          className="terminal-inline-ghost"
          aria-hidden
          style={{
            left: inlineGhost.left,
            top: inlineGhost.top,
            height: inlineGhost.height,
            maxWidth: inlineGhost.maxWidth,
            fontFamily,
            fontSize,
            lineHeight: `${inlineGhost.height}px`,
            color: resolvedTheme.foreground ?? "#eaeaea",
          }}
        >
          {inlineGhost.text}
        </div>
      )}

      {effectiveReadOnly && (
        <div
          data-testid={inputLocked ? "terminal-input-locked" : "terminal-read-only"}
          className="absolute right-3 bottom-3 z-40 px-2 py-1 rounded border bg-white/90 text-[11px] text-slate-700 shadow-sm pointer-events-none"
        >
          {inputLocked ? t("terminal.inputLocked") : t("terminal.readOnlyBadge")}
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
            className="taomni-input h-7 w-56"
            value={searchValue}
            placeholder={t("terminal.findPlaceholder")}
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
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => runSearch("previous")}>
            {t("terminal.findPrev")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => runSearch("next")}>
            {t("terminal.findNext")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={closeSearch}>
            {t("terminal.findClose")}
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
            <span className="font-semibold">{t("terminal.eventLogTitle")}</span>
            <button className="taomni-btn ml-auto h-6 px-2" type="button" onClick={() => setEventLogOpen(false)}>
              {t("terminal.eventLogClose")}
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {eventLog.length === 0 ? (
              <div className="p-3 text-slate-500">{t("terminal.eventLogEmpty")}</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {eventLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="w-20 px-2 py-1 text-slate-500 taomni-mono">{entry.time}</td>
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

      {zmodemState !== "idle" && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 flex items-center gap-3 rounded border border-slate-400 bg-white px-4 py-2 shadow-lg text-[12px]">
          <span className="font-semibold">
            {zmodemState === "receiving" ? t("terminal.zmodemReceiving") : t("terminal.zmodemSending")} {t("terminal.zmodemViaZmodem")}
          </span>
          {zmodemProgress && (
            <>
              <span className="text-slate-600 taomni-mono">{zmodemProgress.fileName}</span>
              <span className="text-slate-500">
                {formatZmodemBytes(zmodemProgress.bytesTransferred)}
                {zmodemProgress.fileSize > 0 && ` / ${formatZmodemBytes(zmodemProgress.fileSize)}`}
              </span>
              {zmodemProgress.fileSize > 0 && (
                <div className="w-32 h-2 rounded bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(100, Math.round(zmodemProgress.bytesTransferred / zmodemProgress.fileSize * 100))}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {contextMenu.render}
      {pasteConfirmDialog}
      {terminalDefaultsConfirmDialog}

      {settingsDialogOpen && (
        <CurrentTerminalSettingsDialog
          profile={currentTerminalProfileRef.current}
          onProfileChange={commitTerminalProfilePatch}
          onSaveAsDefault={() => {
            void saveCurrentProfileAsTerminalDefault();
          }}
          onClose={() => {
            setSettingsDialogOpen(false);
            focusTerminal();
          }}
        />
      )}

      {conflictDialogState && (
        <ZmodemConflictDialog
          fileName={conflictDialogState.fileName}
          hasMore={conflictDialogState.hasMore}
          mode={conflictDialogState.mode}
          onResolve={(action) => {
            setConflictDialogState(null);
            conflictDialogState.resolve(action);
          }}
        />
      )}

      {mfaPrompt && (
        <MfaPrompt
          host={ssh?.host ?? ""}
          username={ssh?.username ?? ""}
          request={mfaPrompt}
          onSubmit={(responses) => {
            void submitSshAuthResponse(mfaPrompt.requestId, responses).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
            focusTerminal();
          }}
          onCancel={() => {
            void submitSshAuthResponse(mfaPrompt.requestId, null).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
          }}
        />
      )}

      {isLocal && supportsShellTools && (
        <CommonCommandsPalette
          open={paletteOpen}
          historyHostKey={historyHostKey}
          userCommands={commonCommands}
          presets={WINDOWS_PRESET_COMMANDS}
          onPick={(cmd) => {
            setPaletteOpen(false);
            sendTerminalInput(cmd);
            focusTerminal();
          }}
          onClose={() => {
            setPaletteOpen(false);
            focusTerminal();
          }}
        />
      )}

      {supportsShellTools && aiRewriteOpen && !isLocalPowerShell && (
        <AiRewriteOverlay
          currentCommand={pendingRef.current}
          onAccept={(newCmd) => {
            setAiRewriteOpen(false);
            // Clear the current pending input and inject the rewritten command.
            // Send backspaces to clear the line, then inject the new command.
            const clearLine = "\x15"; // Ctrl+U clears the line in most shells
            sendTerminalInput(clearLine + newCmd);
            pendingRef.current = newCmd;
            invalidatedRef.current = false;
            refreshSuggestion();
            focusTerminal();
          }}
          onDismiss={() => {
            setAiRewriteOpen(false);
            focusTerminal();
          }}
        />
      )}

      <SelectionToolbar
        visible={!!selectionToolbar}
        rect={selectionToolbar?.rect ?? null}
        selectionText={selectionToolbar?.text ?? ""}
        onCopy={(text) => {
          void writeClipboardText(text, "");
          setSelectionToolbar(null);
        }}
        onSendToAi={(text) => {
          void attachToComposer(text);
          setSelectionToolbar(null);
        }}
        onExplain={(text) => {
          void explainSelection(text);
          setSelectionToolbar(null);
        }}
        onDismiss={() => setSelectionToolbar(null)}
      />
    </div>
  );
}

function CurrentTerminalSettingsDialog({
  profile,
  onProfileChange,
  onSaveAsDefault,
  onClose,
}: {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  onSaveAsDefault: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("terminal.currentSettingsTitle")}
        data-testid="terminal-current-settings-dialog"
        className="max-h-[calc(100vh-32px)] w-[900px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center gap-3 border-b border-[var(--taomni-divider)] px-3">
          <div className="text-[13px] font-semibold">{t("terminal.currentSettingsTitle")}</div>
          <button
            type="button"
            className="taomni-btn ml-auto h-7 w-7 p-0 inline-flex items-center justify-center"
            aria-label={t("terminal.currentSettingsClose")}
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-112px)] overflow-auto p-3">
          <TerminalAppearanceSettings
            profile={profile}
            onProfileChange={onProfileChange}
            showCustomColors
            allowSystemTheme
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] px-3 py-2">
          <button
            type="button"
            className="taomni-btn h-8 px-3"
            onClick={onSaveAsDefault}
          >
            {t("terminal.currentSettingsSaveAsDefault")}
          </button>
          <button type="button" className="taomni-btn h-8 px-3" onClick={onClose}>
            {t("terminal.currentSettingsClose")}
          </button>
        </div>
      </div>
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
    "Taomni SSH terminal",
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

function getLastBufferLines(term: Terminal, lineCount: number): string {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const start = Math.max(0, total - lineCount);
  const lines: string[] = [];
  for (let i = start; i < total; i++) {
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

export function collectTerminalBlockSelectionText(
  term: Pick<Terminal, "buffer" | "cols">,
  selection: TerminalBlockSelection,
): string {
  const range = normalizeTerminalBlockSelection(selection, term.cols);
  const lines: string[] = [];

  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const line = term.buffer.active.getLine(row);
    const text = line ? line.translateToString(false) : "";
    lines.push(text.padEnd(range.endCol, " ").slice(range.startCol, range.endCol).trimEnd());
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function normalizeTerminalBlockSelection(selection: TerminalBlockSelection, cols: number) {
  const startRow = Math.min(selection.anchor.row, selection.focus.row);
  const endRow = Math.max(selection.anchor.row, selection.focus.row);
  const startCol = Math.max(0, Math.min(selection.anchor.col, selection.focus.col));
  const endCol = Math.min(Math.max(startCol + 1, Math.max(selection.anchor.col, selection.focus.col) + 1), cols);
  return { startRow, endRow, startCol, endCol };
}

function terminalCursorCell(term: Terminal): TerminalBlockSelectionCell | null {
  const buffer = term.buffer.active;
  if (buffer.length === 0) return null;
  return {
    row: Math.max(0, Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY)),
    col: Math.max(0, Math.min(term.cols - 1, buffer.cursorX)),
  };
}

function currentTerminalSize(term: Pick<Terminal, "cols" | "rows"> | null): { cols: number; rows: number } {
  return {
    cols: Math.max(2, Math.floor(term?.cols || 80)),
    rows: Math.max(1, Math.floor(term?.rows || 24)),
  };
}

function isMacPrintableOptionInput(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.key.length === 1 &&
    event.key.charCodeAt(0) >= 0x20 &&
    event.key !== " "
  );
}

function isTerminalBlockSelectionMouseEvent(
  event: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey));
}

function terminalCellFromMouseEvent(
  term: Terminal,
  container: HTMLDivElement,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): TerminalBlockSelectionCell | null {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0 || term.buffer.active.length <= 0) return null;

  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  const visibleCol = Math.floor((event.clientX - rect.left) / cellWidth);
  const visibleRow = Math.floor((event.clientY - rect.top) / cellHeight);
  const col = Math.max(0, Math.min(term.cols - 1, visibleCol));
  const row = Math.max(
    0,
    Math.min(term.buffer.active.length - 1, term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, visibleRow))),
  );

  return { row, col };
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

function captureBufferCommand(term: Terminal): string {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;

  // Walk up through wrapped lines to find the start of the logical row.
  let start = cursorRow;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (line?.isWrapped) start -= 1;
    else break;
  }

  let text = "";
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row === cursorRow) {
      const segment = line.translateToString(false).slice(0, buffer.cursorX);
      text += segment;
    } else {
      text += line.translateToString(false);
    }
  }

  return extractTerminalCommand(text);
}

// Heuristic: does the terminal currently show an idle shell prompt waiting for
// input? True only when the cursor line is non-empty AND ends in a common
// prompt terminator with nothing typed after it. This deliberately returns
// false for a blank screen (shell still starting up — e.g. a slow .bashrc /
// conda init), a streaming MOTD, or a half-typed command, so callers that need
// to inject a hidden setup line wait for a clean, ready prompt instead of
// firing into a not-yet-ready shell (whose buffered echo would arrive late and
// leak past the echo suppressor). Covers bash/zsh ("$ "/"# "/"% "), root,
// PowerShell-over-SSH ("> "); fancy custom prompts won't match (callers then
// skip integration, which is safe).
function terminalAtIdlePrompt(term: Terminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.type === "alternate") return false;

  const cursorRow = buffer.baseY + buffer.cursorY;
  let start = cursorRow;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;

  let text = "";
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    text +=
      row === cursorRow
        ? line.translateToString(false).slice(0, buffer.cursorX)
        : line.translateToString(false);
  }

  if (text.replace(/\s+$/, "").length === 0) return false; // blank: not ready
  // Ends in a prompt terminator, optionally followed by a single space.
  return /[$#>%][ ]?$/.test(text);
}

function computeInlineGhost(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  enabled: boolean,
  pending: string,
  suggestion: string | null,
  invalidated: boolean,
): { left: number; top: number; maxWidth: number; height: number; text: string } | null {
  if (!enabled || !term || !panel || !container) return null;
  if (invalidated || !pending || !suggestion) return null;
  if (!suggestion.startsWith(pending) || suggestion.length <= pending.length) return null;
  if (term.buffer.active.type === "alternate") return null;

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return null;
  }

  // Only render when the cursor row is actually on screen (user hasn't scrolled away).
  const cursorX = term.buffer.active.cursorX;
  const cursorY = term.buffer.active.cursorY;
  if (cursorY < 0 || cursorY >= term.rows) return null;

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  const left = baseLeft + cursorX * cellWidth;
  const top = baseTop + cursorY * cellHeight;
  const maxWidth = Math.max(0, (term.cols - cursorX) * cellWidth);
  if (maxWidth <= 0) return null;

  const text = suggestion.slice(pending.length);
  return { left, top, maxWidth, height: cellHeight, text };
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

function getVisibleTerminalBlockSelectionHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  selection: TerminalBlockSelection | null,
) {
  if (!term || !panel || !container || !selection) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const range = normalizeTerminalBlockSelection(selection, term.cols);
  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;
  const startRow = Math.max(range.startRow, viewportTop);
  const endRow = Math.min(range.endRow, viewportBottom);
  const highlights: Array<{ row: number; left: number; top: number; width: number; height: number }> = [];

  for (let row = startRow; row <= endRow; row += 1) {
    highlights.push({
      row,
      left: baseLeft + range.startCol * cellWidth,
      top: baseTop + (row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, (range.endCol - range.startCol) * cellWidth),
      height: cellHeight,
    });
  }

  return highlights;
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

function terminalCanPromptForLocalPathUpload(term: Terminal | null): boolean {
  if (!term) return false;
  if (term.buffer.active.type === "alternate") return false;
  return true;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// When the running app has enabled DEC bracketed paste (CSI ?2004h), wrap the
// payload so the app can distinguish a paste from typed input. The LFs inside
// the envelope are preserved on purpose: modern TUIs (Claude Code, ipython,
// nano, lazygit, ...) read \n as "newline inside the paste" and \r as "submit",
// and on Windows ConPTY there is no termios ICRNL to translate \r→\n the way
// Linux PTYs do. Without this wrapping a 9-line paste arrives as 9 separate
// Enter presses on Windows.
function formatPasteForTerminal(term: Terminal | null, text: string): string {
  if (term?.modes.bracketedPasteMode) {
    return `\x1b[200~${text.replace(/\r\n/g, "\n")}\x1b[201~`;
  }
  return normalizePasteText(text);
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

function terminalProfileSignature(profile: TerminalProfile): string {
  return JSON.stringify(profile);
}

function shouldUseTerminalWebgl(enabled: boolean): boolean {
  if (!enabled) return false;
  // Tauri uses WKWebView on macOS. On Intel/older macOS builds the WebGL
  // renderer can flash, lose context, or leave the terminal blank, while
  // xterm's default renderer stays stable for PTY/SSH output.
  return !(isTauriRuntime() && getAppPlatform() === "macos");
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

/** Build a history line the Welcome recent-folders parser can turn into a path. */
function formatHistoryCdCommand(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "cd";
  if (/[\s"'`]/.test(trimmed) || /[&|;<>]/.test(trimmed)) {
    return `cd "${trimmed.replace(/"/g, '\\"')}"`;
  }
  return `cd ${trimmed}`;
}

function parseOsc52ClipboardText(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;

  const targets = data.slice(0, separator);
  if (targets && !targets.includes("c") && !targets.includes("s")) return null;

  const encoded = data.slice(separator + 1).replace(/\s/g, "");
  if (!encoded || encoded === "?") return encoded === "" ? "" : null;
  if (encoded.length > Math.ceil((OSC52_MAX_DECODED_BYTES * 4) / 3) + 4) return null;

  try {
    const binary = atob(encoded);
    if (binary.length > OSC52_MAX_DECODED_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeBinaryStringBase64(str: string): string {
  let binary = "";
  for (let i = 0; i < str.length; i++) {
    binary += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}

function formatZmodemBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}


// AI inline `??` rendering: stream LLM tokens directly into the terminal as
// gray-styled ANSI text. The rendering is purely visual (xterm.write); it
// never reaches the underlying PTY, so a real `cat`/`grep`/`vim` can run on
// the next prompt without any ghost characters left behind. Each request
// uses a fresh `inline-qq:<request_id>` event channel so concurrent calls
// from different tabs do not cross-contaminate.
async function streamInlineAi(term: Terminal, question: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = `inline-qq:${requestId}`;

  // ANSI: dim gray foreground, bold prefix.
  const PREFIX = "\\x1b[38;5;244m\\x1b[1m[AI]\\x1b[0m\\x1b[38;5;244m ";
  const SUFFIX = "\\x1b[0m";

  // Header line so the user sees the question echoed back.
  term.write(`\\r\\n\\x1b[38;5;244m?? ${question}\\x1b[0m\\r\\n`);
  term.write(PREFIX);

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<{ kind: string; content?: string; message?: string }>(event, (e) => {
      const payload = e.payload;
      if (payload.kind === "token" && payload.content) {
        term.write(payload.content.replace(/\\n/g, "\\r\\n" + PREFIX));
      } else if (payload.kind === "error") {
        if (isVaultLockedError(payload.message ?? "")) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${payload.message ?? "unknown"}${SUFFIX}\\r\\n`);
      } else if (payload.kind === "end") {
        term.write(`${SUFFIX}\\r\\n`);
      }
    });
    await invoke("inline_qq_stream", { requestId, question });
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: {
            reason:
              "This AI provider's API key is in the credential vault — unlock it to continue.",
          },
        }),
      );
    }
    term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${String(e)}${SUFFIX}\\r\\n`);
  } finally {
    if (unlisten) unlisten();
  }
}
