// Shared clipboard helpers used across terminal, SSH, and VNC tabs.
//
// Why one helper: the terminal had its own writeClipboardText with execCommand
// fallback, the VNC panel rolled its own writeText/readText calls, and the
// upcoming ExtendedClipboard / image clipboard work needs a single place that
// knows how to touch the system clipboard with multi-format payloads.

import { invoke } from "@tauri-apps/api/core";

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
  try {
    return await invoke<string>("clipboard_read_text");
  } catch {
    // Fallback to browser API (e.g. in dev mode without Tauri runtime).
  }
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return "";
  }
  return navigator.clipboard.readText();
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
