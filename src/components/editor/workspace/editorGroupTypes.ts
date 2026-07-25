import type { CodeWorkspaceFileRef } from "../../../types";

/** On-disk line ending style preserved across the LF-normalized editor buffer. */
export type OpenFileEol = "LF" | "CRLF" | "CR";

/**
 * A buffer that has no file on disk: JDK / dependency sources delivered by the
 * language server (`jdt://` class contents). Read-only, never written, and its LSP
 * requests ride the origin project's session with `uri` as the document URI.
 */
export interface OpenFileLibrarySource {
  uri: string;
  /** `package · jar/module` origin label, shown instead of a directory trail. */
  container: string | null;
  /** Project root of the file the jump started from (null for loose-file origins). */
  originRootPath: string | null;
  /** File the jump started from; selects the language-server session. */
  originFilePath: string;
}

/** View-model for an open buffer as seen by EditorGroup (presentation only). */
export interface OpenFileViewModel {
  ref: CodeWorkspaceFileRef;
  key: string;
  path: string;
  title: string;
  subtitle: string;
  languagePath: string;
  /** Buffer text with LF line endings (CodeMirror-normalized). */
  text: string;
  /** Last saved buffer text (also LF-normalized). */
  savedText: string;
  /** Original on-disk line ending style; applied on write. */
  eol: OpenFileEol;
  hash: string;
  mtime: number;
  size: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  /** Set for language-server-provided library sources (read-only, no file on disk). */
  library?: OpenFileLibrarySource | null;
}
