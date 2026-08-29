import { marked } from "marked";
import DOMPurify from "dompurify";

export interface DocCommentRange {
  id: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  rawText: string;
  cleanMarkdown: string;
  renderedHtml: string;
}

export const SUPPORTED_DOC_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "java",
  "rust",
  "python",
  "go",
  "cpp",
  "c",
  "php",
  "kotlin",
  "scala",
  "swift",
  "csharp",
]);

export function isDocCommentRenderingSupported(languageId: string | null | undefined): boolean {
  if (!languageId) return false;
  return SUPPORTED_DOC_LANGUAGES.has(languageId.toLowerCase());
}

/**
 * Normalizes JSDoc / Javadoc tags into readable Markdown.
 */
export function normalizeDocCommentText(raw: string, _languageId?: string): string {
  let cleaned = raw;

  if (raw.startsWith("/**") && raw.endsWith("*/")) {
    cleaned = raw
      .slice(3, -2)
      .split("\n")
      .map((line) => line.trim().replace(/^\*\s?/, ""))
      .join("\n");
  } else if (raw.startsWith("///")) {
    cleaned = raw
      .split("\n")
      .map((line) => line.trim().replace(/^\/\/\/\s?/, ""))
      .join("\n");
  } else if ((raw.startsWith('"""') && raw.endsWith('"""')) || (raw.startsWith("'''") && raw.endsWith("'''"))) {
    cleaned = raw.slice(3, -3);
  }

  // Format Javadoc / JSDoc tags
  cleaned = cleaned
    .replace(/^@param\s+([A-Za-z0-9_$]+)\s+(.*)$/gm, "**Parameter** `$1` — $2")
    .replace(/^@return(?:s)?\s+(.*)$/gm, "**Returns** — $1")
    .replace(/^@throws\s+([A-Za-z0-9_$.]+)\s+(.*)$/gm, "**Throws** `$1` — $2")
    .replace(/^@deprecated\s+(.*)$/gm, "⚠️ **Deprecated:** $1")
    .replace(/^@see\s+(.*)$/gm, "**See also:** $1");

  return cleaned.trim();
}

/**
 * Sanitizes and renders markdown into safe HTML for in-place doc rendering.
 */
export function renderDocCommentHtml(markdown: string): string {
  if (!markdown.trim()) return "";

  // Safety: cap max length to prevent giant payload parse stalling
  const safeText = markdown.length > 50000 ? `${markdown.slice(0, 50000)}\n\n*(Documentation truncated)*` : markdown;
  const rawHtml = marked.parse(safeText, { async: false, gfm: true, breaks: true }) as string;

  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      "a", "b", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4",
      "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong",
      "table", "tbody", "td", "th", "thead", "tr", "ul",
    ],
    ALLOWED_ATTR: ["href", "title", "alt", "src", "class", "target", "rel"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}

/**
 * Extracts all doc comments from the document text if the language is supported.
 */
export function extractDocComments(text: string, languageId: string): DocCommentRange[] {
  if (!isDocCommentRenderingSupported(languageId) || !text) {
    return [];
  }

  const results: DocCommentRange[] = [];

  // Regex pattern for block doc comments (/** ... */)
  const blockRegex = /\/\*\*[\s\S]*?\*\//g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const raw = match[0];
    const from = match.index;
    const to = from + raw.length;

    // Calculate line numbers
    const beforeText = text.slice(0, from);
    const startLine = beforeText.split("\n").length - 1;
    const endLine = startLine + raw.split("\n").length - 1;

    const cleanMarkdown = normalizeDocCommentText(raw, languageId);
    const renderedHtml = renderDocCommentHtml(cleanMarkdown);

    results.push({
      id: `doc-${from}-${to}`,
      from,
      to,
      startLine,
      endLine,
      rawText: raw,
      cleanMarkdown,
      renderedHtml,
    });
  }

  return results;
}

const READER_MODE_STORAGE_PREFIX = "taomni.readerMode.";

export function getReaderModeKey(workspaceInstanceId: string, fileKey: string): string {
  return `${READER_MODE_STORAGE_PREFIX}${workspaceInstanceId}.${fileKey}`;
}

export function readReaderModePreference(workspaceInstanceId: string, fileKey: string): boolean {
  try {
    const val = window.localStorage.getItem(getReaderModeKey(workspaceInstanceId, fileKey));
    return val === "true";
  } catch {
    return false;
  }
}

export function writeReaderModePreference(workspaceInstanceId: string, fileKey: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(getReaderModeKey(workspaceInstanceId, fileKey), String(enabled));
  } catch {
    // Ignore storage quota errors
  }
}
