import { invoke } from "@tauri-apps/api/core";

export interface LspServerCommandPreset {
  id: string;
  label: string;
  command: string;
  args: string[];
  installHint: string;
  fallback: boolean;
}

export interface LspServerPreset {
  id: string;
  displayName: string;
  documentLanguageIds: string[];
  fileExtensions: string[];
  fileNames: string[];
  commands: LspServerCommandPreset[];
}

export interface LspCustomServerCommand {
  label?: string | null;
  command: string;
  args: string[];
}

export interface LspServerCommandStatus extends LspServerCommandPreset {
  available: boolean;
}

export interface LspServerStatus {
  presetId: string;
  displayName: string;
  documentLanguageIds: string[];
  available: boolean;
  active: boolean;
  selectedCommandId: string | null;
  selectedCommand: string | null;
  installHint: string;
  error: string | null;
  /** Runtime probe from the backend (e.g. Java major + path for jdtls). */
  runtimeStatus?: string | null;
  commands: LspServerCommandStatus[];
}

export interface LspCapabilitySummary {
  /** LSP TextDocumentSyncKind: 0 = none, 1 = full, 2 = incremental. */
  textDocumentSyncKind?: number;
  completion: boolean;
  signatureHelp: boolean;
  hover: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  rename: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  codeAction: boolean;
  documentHighlight: boolean;
  callHierarchy: boolean;
  typeHierarchy: boolean;
  inlayHint: boolean;
  selectionRange: boolean;
  semanticTokens: boolean;
  completionTriggerCharacters: string[];
  signatureTriggerCharacters: string[];
}

export interface LspDocumentStatus {
  path: string;
  uri: string;
  presetId: string | null;
  languageId: string | null;
  displayName: string | null;
  available: boolean;
  active: boolean;
  selectedCommandId: string | null;
  selectedCommand: string | null;
  installHint: string | null;
  error: string | null;
  capabilities?: LspCapabilitySummary | null;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDocumentContentChange {
  range: LspRange;
  rangeLength: number;
  text: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number | null;
  code: string | null;
  source: string | null;
  message: string;
}

export interface LspLocation {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface LspDiagnosticsResult {
  status: LspDocumentStatus;
  diagnostics: LspDiagnostic[];
}

export interface LspHoverResult {
  status: LspDocumentStatus;
  contents: string | null;
  range: LspRange | null;
}

export interface LspLocationsResult {
  status: LspDocumentStatus;
  locations: LspLocation[];
}

/** Library / virtual document opened from jdt://, jar:, or an absolute file URI. */
export interface LspUriContentsResult {
  status: LspDocumentStatus;
  uri: string;
  path: string | null;
  title: string;
  /** Package · jar/module label for the tab subtitle. */
  container: string | null;
  languageId: string;
  text: string;
  readOnly: boolean;
  /** True when `text` is decompiled bytecode; the UI offers "Download sources". */
  decompiled: boolean;
}

/** Outcome of an on-demand "Download sources" request (jdtls Java classes). */
export interface LspDownloadSourcesResult {
  /** True when attached (non-decompiled) source is now available. */
  attached: boolean;
  /** Fresh class contents to swap into the open buffer. */
  text: string;
  decompiled: boolean;
  /** Why nothing was attached, when `attached` is false. */
  message: string | null;
}

export interface LspDocumentSymbol {
  name: string;
  detail: string | null;
  kind: number;
  depth: number;
  range: LspRange;
  selectionRange: LspRange;
}

export interface LspDocumentSymbolsResult {
  status: LspDocumentStatus;
  symbols: LspDocumentSymbol[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspCompletionItem {
  label: string;
  kind: number | null;
  detail: string | null;
  documentation: string | null;
  insertText: string | null;
  /** 1 = plain text, 2 = snippet. */
  insertTextFormat: number | null;
  filterText: string | null;
  sortText: string | null;
  textEdit: LspTextEdit | null;
  additionalTextEdits: LspTextEdit[];
  /** Original server item, passed back verbatim to completionItem/resolve. */
  raw: unknown;
}

export interface LspCompletionResult {
  status: LspDocumentStatus;
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspSignatureParameter {
  label: string;
  documentation: string | null;
  labelStart: number | null;
  labelEnd: number | null;
}

export interface LspSignatureInfo {
  label: string;
  documentation: string | null;
  parameters: LspSignatureParameter[];
  activeParameter: number | null;
}

export interface LspSignatureHelpResult {
  status: LspDocumentStatus;
  signatures: LspSignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

export interface LspDocumentDescriptor {
  workspaceId: string;
  rootPath?: string | null;
  filePath: string;
  /**
   * Virtual document URI to request instead of `filePath`'s own file URI, used by
   * library buffers (JDK / dependency `jdt://` sources). `filePath` still selects
   * the language-server session, so it must point at a file in the origin project.
   */
  documentUri?: string | null;
  languageId?: string | null;
  serverCommandId?: string | null;
  customServerCommand?: LspCustomServerCommand | null;
  /** Optional JDK home or java binary for jdtls (Java 21+). */
  javaHome?: string | null;
}

function documentArgs(descriptor: LspDocumentDescriptor) {
  return {
    workspaceId: descriptor.workspaceId,
    rootPath: descriptor.rootPath ?? null,
    filePath: descriptor.filePath,
    documentUri: descriptor.documentUri?.trim() || null,
    languageId: descriptor.languageId ?? null,
    serverCommandId: descriptor.serverCommandId ?? null,
    customServerCommand: descriptor.customServerCommand ?? null,
    javaHome: descriptor.javaHome?.trim() || null,
  };
}

export function lspListPresets(): Promise<LspServerPreset[]> {
  return invoke<LspServerPreset[]>("lsp_list_presets");
}

/** Detect installed language servers. Pass `javaHome` to probe jdtls with a configured JDK. */
export function lspDetectServers(options?: { javaHome?: string | null }): Promise<LspServerStatus[]> {
  const javaHome = options?.javaHome?.trim() || null;
  return invoke<LspServerStatus[]>("lsp_detect_servers", { javaHome });
}

/** Apply the configured JDK for jdtls globally in the backend process. */
export function lspSetJavaHome(javaHome?: string | null): Promise<void> {
  return invoke("lsp_set_java_home", {
    javaHome: javaHome?.trim() || null,
  });
}

/**
 * Apply free-form jdtls JVM args globally (e.g. `-Xmx2G -XX:+UseG1GC`).
 * Null/empty restores the default `-Xms1024m -Xmx1024m`.
 * Returns the effective args string after normalize.
 */
export function lspSetJavaVmargs(vmargs?: string | null): Promise<string> {
  const value = vmargs?.trim() || null;
  return invoke<string>("lsp_set_java_vmargs", { vmargs: value });
}

/**
 * jdtls `java.*` language settings mirrored to the backend. Field names match the
 * Rust `JavaLanguageSettings` serde shape (camelCase); the backend fills any omitted
 * field from its defaults, so partial payloads are safe.
 */
export interface LspJavaSettings {
  autobuildEnabled: boolean;
  lombokEnabled: boolean;
  lombokJarPath: string;
  saveActionsOrganizeImports: boolean;
  formatSettingsUrl: string;
  formatSettingsProfile: string;
  guessMethodArguments: boolean;
  completionImportOrder: string[];
  organizeImportsStarThreshold: number;
  organizeImportsStaticStarThreshold: number;
  mavenImportEnabled: boolean;
  gradleImportEnabled: boolean;
}

/**
 * Apply jdtls `java.*` language settings (Lombok, autobuild, organize imports, …).
 * Live settings hot-update running jdtls sessions via didChangeConfiguration; the
 * Lombok `-javaagent` applies on the next workspace restart. `null` restores defaults.
 * Returns the number of sessions that received the live update.
 */
export function lspSetJavaSettings(settings: LspJavaSettings | null): Promise<number> {
  return invoke<number>("lsp_set_java_settings", { settings });
}

export function lspDocumentStatus(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_document_status", documentArgs(descriptor));
}

export function lspOpenDocument(
  descriptor: LspDocumentDescriptor,
  text: string,
  version: number,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_open_document", {
    ...documentArgs(descriptor),
    text,
    version,
  });
}

export function lspChangeDocument(
  descriptor: LspDocumentDescriptor,
  text: string | null,
  version: number,
  change: LspDocumentContentChange | null = null,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_change_document", {
    ...documentArgs(descriptor),
    text,
    change,
    version,
  });
}

export function lspSaveDocument(
  descriptor: LspDocumentDescriptor,
  text: string | null,
  version: number,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_save_document", {
    ...documentArgs(descriptor),
    text,
    version,
  });
}

export function lspCloseDocument(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_close_document", documentArgs(descriptor));
}

export function lspStopWorkspace(workspaceId: string): Promise<number> {
  return invoke<number>("lsp_stop_workspace", { workspaceId });
}

export function lspGetDiagnostics(
  descriptor: LspDocumentDescriptor,
): Promise<LspDiagnosticsResult> {
  return invoke<LspDiagnosticsResult>("lsp_get_diagnostics", documentArgs(descriptor));
}

/** One file's diagnostics in the workspace-wide Problems view (M7-C). */
export interface WorkspaceDiagnosticFile {
  path: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

/**
 * All diagnostics stored across the workspace's active sessions, including files
 * the user never opened (jdtls publishes project-wide after a build). Used by the
 * Problems panel's "whole project" mode; the panel polls this while open.
 */
export function lspWorkspaceDiagnostics(workspaceId: string): Promise<WorkspaceDiagnosticFile[]> {
  return invoke<WorkspaceDiagnosticFile[]>("lsp_workspace_diagnostics", { workspaceId });
}

/**
 * Trigger a full jdtls project rebuild (java.buildWorkspace) so diagnostics for
 * unopened files are (re)published. `descriptor` selects the jdtls session.
 */
export function lspBuildWorkspace(descriptor: LspDocumentDescriptor): Promise<void> {
  return invoke("lsp_build_workspace", documentArgs(descriptor));
}

export function lspDocumentSymbols(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentSymbolsResult> {
  return invoke<LspDocumentSymbolsResult>("lsp_document_symbols", documentArgs(descriptor));
}

export function lspCompletion(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
): Promise<LspCompletionResult> {
  return invoke<LspCompletionResult>("lsp_completion", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
  });
}

export function lspCompletionResolve(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspCompletionItem | null> {
  return invoke<LspCompletionItem | null>("lsp_completion_resolve", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspSignatureHelp(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
): Promise<LspSignatureHelpResult> {
  return invoke<LspSignatureHelpResult>("lsp_signature_help", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
  });
}

export interface LspFormattingResult {
  status: LspDocumentStatus;
  edits: LspTextEdit[];
}

export interface LspFormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
}

export function lspFormatting(
  descriptor: LspDocumentDescriptor,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_formatting", {
    ...documentArgs(descriptor),
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export function lspRangeFormatting(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_range_formatting", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export interface LspFileTextEdits {
  uri: string;
  path: string | null;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  documentEdits: LspFileTextEdits[];
}

export interface LspCodeAction {
  title: string;
  kind: string | null;
  isPreferred: boolean;
  edit: LspWorkspaceEdit | null;
  command: string | null;
  commandArguments: unknown;
  raw: unknown;
}

export interface LspCodeActionsResult {
  status: LspDocumentStatus;
  actions: LspCodeAction[];
}

export function lspCodeActions(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  diagnostics?: unknown[] | null,
): Promise<LspCodeActionsResult> {
  return invoke<LspCodeActionsResult>("lsp_code_actions", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    diagnostics: diagnostics ?? null,
  });
}

export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  containerName: string | null;
  uri: string;
  path: string | null;
  range: LspRange;
  selectionRange: LspRange;
}

export interface LspWorkspaceSymbolsResult {
  status: LspDocumentStatus;
  symbols: LspWorkspaceSymbol[];
}

export interface LspHierarchyItem {
  name: string;
  detail: string | null;
  kind: number;
  uri: string;
  path: string | null;
  range: LspRange;
  selectionRange: LspRange;
  /** Original server item retained for lazy hierarchy requests. */
  raw: unknown;
}

export interface LspHierarchyPrepareResult {
  status: LspDocumentStatus;
  items: LspHierarchyItem[];
}

export interface LspCallHierarchyEntry {
  item: LspHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyResult {
  status: LspDocumentStatus;
  entries: LspCallHierarchyEntry[];
}

export interface LspTypeHierarchyResult {
  status: LspDocumentStatus;
  items: LspHierarchyItem[];
}

export interface LspDocumentHighlight {
  range: LspRange;
  /** 1 = text, 2 = read, 3 = write. */
  kind: number | null;
}

export interface LspDocumentHighlightsResult {
  status: LspDocumentStatus;
  highlights: LspDocumentHighlight[];
}

export interface LspInlayHint {
  position: LspPosition;
  label: string;
  /** 1 = type, 2 = parameter. */
  kind: number | null;
  tooltip: string | null;
  paddingLeft: boolean;
  paddingRight: boolean;
}

export interface LspInlayHintsResult {
  status: LspDocumentStatus;
  hints: LspInlayHint[];
}

export interface LspSelectionRangesResult {
  status: LspDocumentStatus;
  ranges: LspRange[];
}

export interface LspSemanticToken {
  range: LspRange;
  tokenType: string;
  modifiers: string[];
}

export interface LspSemanticTokensResult {
  status: LspDocumentStatus;
  tokens: LspSemanticToken[];
}

export function lspWorkspaceSymbols(
  descriptor: LspDocumentDescriptor,
  query: string,
): Promise<LspWorkspaceSymbolsResult> {
  return invoke<LspWorkspaceSymbolsResult>("lsp_workspace_symbols", {
    ...documentArgs(descriptor),
    query,
  });
}

export function lspPrepareCallHierarchy(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspHierarchyPrepareResult> {
  return invoke<LspHierarchyPrepareResult>("lsp_prepare_call_hierarchy", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspCallHierarchyIncoming(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspCallHierarchyResult> {
  return invoke<LspCallHierarchyResult>("lsp_call_hierarchy_incoming", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspCallHierarchyOutgoing(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspCallHierarchyResult> {
  return invoke<LspCallHierarchyResult>("lsp_call_hierarchy_outgoing", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspPrepareTypeHierarchy(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspHierarchyPrepareResult> {
  return invoke<LspHierarchyPrepareResult>("lsp_prepare_type_hierarchy", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspTypeHierarchySupertypes(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspTypeHierarchyResult> {
  return invoke<LspTypeHierarchyResult>("lsp_type_hierarchy_supertypes", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspTypeHierarchySubtypes(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspTypeHierarchyResult> {
  return invoke<LspTypeHierarchyResult>("lsp_type_hierarchy_subtypes", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspDocumentHighlights(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspDocumentHighlightsResult> {
  return invoke<LspDocumentHighlightsResult>("lsp_document_highlights", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspInlayHints(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
): Promise<LspInlayHintsResult> {
  return invoke<LspInlayHintsResult>("lsp_inlay_hints", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  });
}

export function lspSelectionRanges(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspSelectionRangesResult> {
  return invoke<LspSelectionRangesResult>("lsp_selection_ranges", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspSemanticTokens(
  descriptor: LspDocumentDescriptor,
): Promise<LspSemanticTokensResult> {
  return invoke<LspSemanticTokensResult>("lsp_semantic_tokens", {
    ...documentArgs(descriptor),
  });
}

export interface LspPrepareRenameResult {
  status: LspDocumentStatus;
  range: LspRange | null;
  placeholder: string | null;
  allowed: boolean;
  message: string | null;
}

export interface LspRenameResult {
  status: LspDocumentStatus;
  edit: LspWorkspaceEdit;
}

export function lspPrepareRename(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspPrepareRenameResult> {
  return invoke<LspPrepareRenameResult>("lsp_prepare_rename", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspRename(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  newName: string,
): Promise<LspRenameResult> {
  return invoke<LspRenameResult>("lsp_rename", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    newName,
  });
}

/** LSP SymbolKind values treated as "classes" in Search Everywhere. */
export const LSP_CLASS_SYMBOL_KINDS = new Set([5, 10, 11, 23, 26]);

export function lspHover(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspHoverResult> {
  return invoke<LspHoverResult>("lsp_hover", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspDefinition(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_definition", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspTypeDefinition(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_type_definition", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspImplementation(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_implementation", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

/**
 * Load contents for a definition/reference URI that is not a workspace file
 * (JDK classes, dependency JARs via jdtls `java/classFileContents`, or absolute paths).
 */
export function lspReadUriContents(
  descriptor: LspDocumentDescriptor,
  uri: string,
): Promise<LspUriContentsResult> {
  return invoke<LspUriContentsResult>("lsp_read_uri_contents", {
    ...documentArgs(descriptor),
    uri,
  });
}

/**
 * On-demand "Download sources" for a Java library class (jdtls only). `descriptor`
 * must resolve to a file in the origin project (its session drives the download);
 * `uri` is the jdt:// class URI to refresh. Long-running: jdtls fetches the sources
 * JAR via Maven/Gradle before attached source replaces the decompiled bytecode.
 */
export function lspDownloadSources(
  descriptor: LspDocumentDescriptor,
  uri: string,
): Promise<LspDownloadSourcesResult> {
  return invoke<LspDownloadSourcesResult>("lsp_download_sources", {
    ...documentArgs(descriptor),
    uri,
  });
}

/**
 * Reload the Java project model (IDEA "Reload project") after a build file
 * (pom.xml / build.gradle) changed. Fire-and-forget: jdtls re-imports async.
 * `descriptor` should target the changed build file (or any project file).
 */
export function lspReloadProject(descriptor: LspDocumentDescriptor): Promise<void> {
  return invoke("lsp_reload_project", documentArgs(descriptor));
}

/** A Java project/module discovered by jdtls `java.project.getAll` (M7 F-4). */
export interface JavaModule {
  name: string;
  path: string;
  uri: string;
}

/**
 * List the Java projects/modules via jdtls `java.project.getAll`. `descriptor`
 * selects the jdtls session (any project file works). Returns [] when the server
 * lacks the command; rejects when no session is active.
 */
export function lspJavaModules(descriptor: LspDocumentDescriptor): Promise<JavaModule[]> {
  return invoke<JavaModule[]>("lsp_java_modules", documentArgs(descriptor));
}

export function lspReferences(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  includeDeclaration = true,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_references", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    includeDeclaration,
  });
}
