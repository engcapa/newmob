import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectIndentation,
  detectWorkspaceEol,
  useCodeWorkspaceStatusStore,
  type CodeWorkspaceStatusSegments,
} from "./codeWorkspaceStatusStore";

function sample(overrides: Partial<CodeWorkspaceStatusSegments> = {}): CodeWorkspaceStatusSegments {
  return {
    tabId: "tab-1",
    line: 1,
    column: 1,
    encoding: "UTF-8",
    eol: "LF",
    languageId: "typescript",
    lspActive: true,
    lspLabel: "typescript-language-server",
    lspError: false,
    gitBranch: "main",
    gitAhead: 0,
    gitBehind: 0,
    fontSize: 13,
    largeFile: false,
    ...overrides,
  };
}

describe("codeWorkspaceStatusStore", () => {
  beforeEach(() => {
    useCodeWorkspaceStatusStore.setState({ status: null, actions: null });
  });

  it("detects common end-of-line styles", () => {
    expect(detectWorkspaceEol("a\nb")).toBe("LF");
    expect(detectWorkspaceEol("a\r\nb")).toBe("CRLF");
    expect(detectWorkspaceEol("a\rb")).toBe("CR");
  });

  it("detects indentation styles (2-spaces, 4-spaces, tabs)", () => {
    expect(detectIndentation("function a() {\n  const x = 1;\n  return x;\n}").label).toBe("Spaces: 2");
    expect(detectIndentation("function b() {\n    const x = 1;\n    return x;\n}").label).toBe("Spaces: 4");
    expect(detectIndentation("function c() {\n\tconst x = 1;\n\treturn x;\n}").label).toBe("Tab: 4");
  });

  it("dedupes identical status updates", () => {
    const store = useCodeWorkspaceStatusStore.getState();
    store.setStatus(sample());
    const first = useCodeWorkspaceStatusStore.getState().status;
    store.setStatus(sample());
    expect(useCodeWorkspaceStatusStore.getState().status).toBe(first);
  });

  it("clears status and actions for the owning tab", () => {
    const openLanguagePanel = vi.fn();
    const store = useCodeWorkspaceStatusStore.getState();
    store.setStatus(sample());
    store.setActions("tab-1", { openLanguagePanel });
    store.clearForTab("tab-1");
    expect(useCodeWorkspaceStatusStore.getState().status).toBeNull();
    expect(useCodeWorkspaceStatusStore.getState().actions).toBeNull();
  });

  it("ignores action registration from a non-active tab", () => {
    const store = useCodeWorkspaceStatusStore.getState();
    store.setStatus(sample({ tabId: "tab-a" }));
    store.setActions("tab-b", { openGitManager: vi.fn() });
    expect(useCodeWorkspaceStatusStore.getState().actions).toBeNull();
  });
});
