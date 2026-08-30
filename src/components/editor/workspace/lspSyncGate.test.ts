import { describe, expect, it } from "vitest";
import type { LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  isLspFeatureReady,
  shouldLiveSyncLsp,
  shouldProbeLsp,
  type LspFileState,
} from "./codeWorkspaceModel";

function status(partial: Partial<LspDocumentStatus> & Pick<LspDocumentStatus, "active" | "available">): LspDocumentStatus {
  return {
    path: "/repo/A.java",
    uri: "file:///repo/A.java",
    presetId: "java",
    languageId: "java",
    displayName: "Java",
    selectedCommandId: "jdtls",
    selectedCommand: "jdtls",
    installHint: null,
    error: null,
    ...partial,
  };
}

function state(partial: Partial<LspFileState> = {}): LspFileState {
  return {
    status: null,
    diagnostics: [],
    syncing: false,
    syncedText: null,
    error: null,
    errorGeneration: 0,
    ...partial,
  };
}

describe("LSP sync gates", () => {
  it("never live-syncs or probes files without a language preset", () => {
    expect(shouldLiveSyncLsp("readme.md", null)).toBe(false);
    expect(shouldProbeLsp("notes.txt", null)).toBe(false);
    expect(shouldLiveSyncLsp("data.json", state({ status: status({ active: true, available: true }) }))).toBe(false);
  });

  it("only live-syncs when the session is active or an open is in flight", () => {
    expect(shouldLiveSyncLsp("Main.java", null)).toBe(false);
    expect(shouldLiveSyncLsp("Main.java", state())).toBe(false);
    expect(shouldLiveSyncLsp("Main.java", state({
      status: status({ active: false, available: false }),
    }))).toBe(false);
    expect(shouldLiveSyncLsp("Main.java", state({
      status: status({ active: false, available: true }),
      syncing: true,
    }))).toBe(true);
    expect(shouldLiveSyncLsp("Main.java", state({
      status: status({ active: true, available: true }),
    }))).toBe(true);
  });

  it("probes once for known languages but stops when unavailable or sticky error", () => {
    expect(shouldProbeLsp("Main.java", null)).toBe(true);
    expect(shouldProbeLsp("Main.java", state())).toBe(true);
    expect(shouldProbeLsp("Main.java", state({
      status: status({ active: false, available: false }),
    }))).toBe(false);
    expect(shouldProbeLsp("Main.java", state({
      status: status({ active: false, available: true }),
      error: "spawn jdtls failed",
      syncing: false,
    }))).toBe(false);
    expect(shouldProbeLsp("Main.java", state({
      status: status({ active: true, available: true }),
    }))).toBe(true);
  });

  it("marks features ready only for active sessions", () => {
    expect(isLspFeatureReady(null)).toBe(false);
    expect(isLspFeatureReady(state({ status: status({ active: false, available: true }) }))).toBe(false);
    expect(isLspFeatureReady(state({ status: status({ active: true, available: true }) }))).toBe(true);
  });
});
