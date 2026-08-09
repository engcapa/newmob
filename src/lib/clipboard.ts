// Shared clipboard helpers used across terminal, SSH, and VNC tabs.
//
// Why one helper: the terminal had its own writeClipboardText with execCommand
// fallback, the VNC panel rolled its own writeText/readText calls, and the
// upcoming ExtendedClipboard / image clipboard work needs a single place that
// knows how to touch the system clipboard with multi-format payloads.

import { invoke } from "@tauri-apps/api/core";
import { getAppPlatform, isTauriRuntime } from "./runtime";

export interface MultiFormatPayload {
  text: string;
  html?: string;
  rtf?: string;
}

export interface PasteResult {
  text: string;
  html?: string;
  rtf?: string;
}

export interface ClipboardCapabilities {
  platform: string;
  displayBackend: string;
  webkitApiExpected: boolean;
  nativeBackend: string;
  wlPaste: boolean;
  wlCopy: boolean;
  xclip: boolean;
  xsel: boolean;
  htmlRtfNative: boolean;
}

export async function probeClipboardCapabilities(): Promise<ClipboardCapabilities | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<ClipboardCapabilities>("clipboard_capabilities");
  } catch {
    return null;
  }
}

function fallbackCopyText(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function readText(): Promise<string> {
  // On macOS WKWebView, navigator.clipboard.readText() can show the native
  // "Paste" confirmation popover even for a user-triggered terminal paste.
  // The desktop app has a native clipboard command, so prefer it on macOS.
  // Windows keeps the existing webview-first order; Linux keeps the webview
  // path that avoids the X11 round-trip issue below.
  if (isTauriRuntime() && getAppPlatform() === "macos") {
    try {
      return await invoke<string>("clipboard_read_text");
    } catch {
      // Fall back to the webview API / final native retry below.
    }
  }

  // Prefer the webview clipboard API on Linux/X11. arboard's get_text() must
  // round-trip a SelectionRequest to whichever process owns the CLIPBOARD
  // selection. When that owner is our own webview (e.g. the user copied text
  // from the AI chat panel), the request has to be answered on webkit's GTK
  // main thread, which can stall for seconds while chat is streaming. The
  // webview API resolves the same read against webkit's internal selection
  // state without leaving the process.
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Permissions denied / no user gesture / unfocused — fall back to Rust.
    }
  }
  try {
    return await invoke<string>("clipboard_read_text");
  } catch {
    return "";
  }
}

export async function readFiles(): Promise<string[]> {
  try {
    return await invoke<string[]>("clipboard_read_files");
  } catch {
    return [];
  }
}

export async function writeFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await invoke("clipboard_write_files", { paths });
}

export async function writeText(text: string): Promise<void> {
  if (!text) return;
  try {
    await invoke("clipboard_write_text", { text });
    return;
  } catch {
    // Fallback to browser API (e.g. in dev mode without Tauri runtime).
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      if (fallbackCopyText(text)) return;
      throw err;
    }
  }
  if (!fallbackCopyText(text)) {
    throw new Error("Clipboard not available");
  }
}

export async function writeMultiFormat(payload: MultiFormatPayload): Promise<void> {
  const { text, html, rtf } = payload;
  const hasItem = typeof ClipboardItem !== "undefined" && navigator.clipboard?.write;

  if (hasItem && (html || rtf)) {
    const items: Record<string, Blob> = {
      "text/plain": new Blob([text], { type: "text/plain" }),
    };
    if (html) items["text/html"] = new Blob([html], { type: "text/html" });
    // Browsers reject most non-standard MIME types in ClipboardItem, including
    // "text/rtf". Skip RTF in the multi-format path; if a caller really needs
    // RTF on the clipboard they should request the platform-specific path.
    try {
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return;
    } catch {
      // Fall through to plain text.
    }
  }
  await writeText(text);
}

/** Write a PNG blob as an image to the system clipboard. */
export async function writeImagePng(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Image clipboard not supported in this environment");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/**
 * Read a system clipboard image into a temp PNG via native arboard.
 *
 * WebKitGTK (Linux Tauri) often omits image/* from paste events even when the
 * OS clipboard holds a screenshot or "copy image" bitmap. Chat already uses
 * `chat_read_clipboard_image_attachment`; mail compose reuses the same path.
 */
export async function readNativeClipboardImagePath(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const attachment = await invoke<{ path?: string | null } | null>(
      "chat_read_clipboard_image_attachment",
    );
    const path = typeof attachment?.path === "string" ? attachment.path.trim() : "";
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort image files from the async Clipboard API (browser / some webviews).
 * Returns [] when unavailable or permission is denied.
 */
export async function readClipboardImageFiles(): Promise<File[]> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith("image/")) continue;
        try {
          const blob = await item.getType(type);
          const ext = type.split("/")[1]?.split(";")[0] || "png";
          files.push(new File([blob], `pasted-image.${ext}`, { type }));
        } catch {
          // Skip unreadable type.
        }
      }
    }
    return files;
  } catch {
    return [];
  }
}

/** Read multi-format clipboard. Returns text plus html/rtf when available. */
export async function readMultiFormat(): Promise<PasteResult> {
  const text = await readText();
  const result: PasteResult = { text };

  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    return result;
  }

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html") && !result.html) {
        try {
          const blob = await item.getType("text/html");
          result.html = await blob.text();
        } catch {
          // Ignore
        }
      }
      if (item.types.includes("text/rtf") && !result.rtf) {
        try {
          const blob = await item.getType("text/rtf");
          result.rtf = await blob.text();
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Some platforms (or insecure contexts) reject .read(); plain text is fine.
  }
  return result;
}
