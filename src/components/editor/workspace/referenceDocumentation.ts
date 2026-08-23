import type { LspRange } from "../../../lib/editor/lsp";
import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { isTauriRuntime } from "../../../lib/runtime";

export interface ReferenceDocLink {
  label: string;
  url: string;
}

export interface ReferenceSourceLocation {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface ReferenceContentEnvelope {
  title: string;
  signature?: string | null;
  body: string;
  source: string;
  /** Provider document identity; not necessarily a navigable symbol location. */
  uri?: string | null;
  sourceLocation?: ReferenceSourceLocation | null;
  links?: ReferenceDocLink[];
  revision?: number | null;
  generation?: number | null;
}

export type QuickDocContent = ReferenceContentEnvelope;

export type ExternalDocDecision =
  | { kind: "allowed"; url: string }
  | {
      kind: "unavailable";
      reason: "no-url" | "invalid-scheme" | "malformed" | "open-failed";
    };

export function validateExternalDocUrl(
  raw: string | null | undefined,
  options: { allowHttp?: boolean } = {},
): ExternalDocDecision {
  if (!raw || !raw.trim()) return { kind: "unavailable", reason: "no-url" };
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  // §8.18.6: https always allowed; plain http only when the workspace policy
  // opts in; anything that could carry embedded credentials or execute is a
  // hard reject regardless of scheme.
  if (parsed.username || parsed.password) {
    return { kind: "unavailable", reason: "invalid-scheme" };
  }
  if (parsed.protocol === "https:") {
    return { kind: "allowed", url: parsed.toString() };
  }
  if (parsed.protocol === "http:" && options.allowHttp === true) {
    return { kind: "allowed", url: parsed.toString() };
  }
  return { kind: "unavailable", reason: "invalid-scheme" };
}

export async function openExternalDocumentation(
  raw: string | null | undefined,
  opener: (url: string) => Promise<void> = openSystemExternalUrl,
): Promise<ExternalDocDecision> {
  const decision = validateExternalDocUrl(raw);
  if (decision.kind !== "allowed") return decision;
  try {
    await opener(decision.url);
    return decision;
  } catch {
    return { kind: "unavailable", reason: "open-failed" };
  }
}

export async function openSystemExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    await tauriOpen(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("The browser blocked the documentation window");
  opened.opener = null;
}

export function referenceHrefFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href") ?? null;
}
