import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { LspCompletionItem, LspCompletionResult, LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  buildCompletionAcceptancePlanV2,
  classifyCompletionResolveOutcome,
  commitLspCompletion,
  completionItemId,
  createLspCompletionSource,
  executeCompletionResolve,
  planCompletionChanges,
  providerScopeFor,
  recentCompletionInvocations,
  recordBasicCompletionInvocation,
  resetBasicCompletionSession,
  resetCompletionTelemetry,
  type CompletionRequestIdentity,
  type CompletionRequestToken,
  type CompletionResolveGateRequest,
  type LspCompletionHooks,
} from "./lspCompletion";

const IDENTITY: CompletionRequestIdentity = {
  workspaceId: "ws-r3",
  fileKey: "A.java",
  filePath: "/repo/A.java",
  uri: "file:///repo/A.java",
  languageId: "java",
  documentRevision: 7,
  lspSessionGeneration: 3,
};

function status(active: boolean): LspDocumentStatus {
  return {
    path: "/repo/A.java",
    uri: "file:///repo/A.java",
    presetId: "java",
    languageId: "java",
    displayName: "Java",
    available: true,
    active,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function makeItem(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return {
    label: "asList",
    kind: 3,
    detail: "java.util.Arrays.asList",
    documentation: null,
    insertText: null,
    insertTextFormat: 1,
    filterText: null,
    sortText: "0001",
    textEdit: {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
      newText: "asList",
    },
    additionalTextEdits: [],
    raw: { label: "asList" },
    ...overrides,
  };
}

function resultWith(items: LspCompletionItem[]): LspCompletionResult {
  return { status: status(true), isIncomplete: false, items };
}

function makeHooks(overrides: Partial<LspCompletionHooks> = {}): LspCompletionHooks {
  return {
    identity: () => ({ ...IDENTITY }),
    fetch: async () => resultWith([makeItem()]),
    triggerCharacters: () => [],
    getDocumentRevision: () => IDENTITY.documentRevision,
    reportDiagnostic: vi.fn(),
    ...overrides,
  };
}

function mountView(docText: string): EditorView {
  const state = EditorState.create({
    doc: docText,
    extensions: [history()],
  });
  return new EditorView({ state, parent: document.body });
}

async function runSource(
  view: EditorView,
  hooks: LspCompletionHooks,
  position = 4,
  explicit = true,
): Promise<CompletionResult | null> {
  const source = createLspCompletionSource(hooks);
  return source(new CompletionContext(view.state, position, explicit));
}

function applyFirstOption(view: EditorView, result: unknown): void {
  const options = (result as { options?: Array<{ apply?: (v: EditorView, o: unknown, f: number, t: number) => void }> }).options ?? [];
  const option = options[0];
  if (!option || typeof option.apply !== "function") throw new Error("no applicable option");
  option.apply(view, option, 1, 4);
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.useRealTimers();
});

describe("§8.19.4 Basic invocation ordinal", () => {
  it("advances only on explicit invocations; typing/trigger inherit without bumping", () => {
    resetCompletionTelemetry();
    const base = {
      workspaceId: "ws",
      fileKey: "f",
      documentRevision: 4,
      positionKey: "0:10",
      providerGeneration: 1,
    };
    expect(recordBasicCompletionInvocation({ ...base, reason: "explicit" })).toBe(1);
    expect(recordBasicCompletionInvocation({ ...base, reason: "typing" })).toBe(1);
    expect(recordBasicCompletionInvocation({ ...base, reason: "trigger" })).toBe(1);
    expect(recordBasicCompletionInvocation({ ...base, reason: "explicit" })).toBe(2);
    // Inherit the live sequence once an explicit call is open.
    expect(recordBasicCompletionInvocation({ ...base, reason: "typing" })).toBe(2);
    expect(recordBasicCompletionInvocation({ ...base, reason: "explicit" })).toBe(3);
  });

  it("resets on revision change, caret move, provider restart and popup close", () => {
    resetCompletionTelemetry();
    const base = { workspaceId: "ws", fileKey: "f", positionKey: "0:10", providerGeneration: 1 };
    recordBasicCompletionInvocation({ ...base, documentRevision: 4, reason: "explicit" });
    recordBasicCompletionInvocation({ ...base, documentRevision: 4, reason: "explicit" });
    // Any edit resets the next explicit call.
    expect(recordBasicCompletionInvocation({ ...base, documentRevision: 5, reason: "explicit" })).toBe(1);
    recordBasicCompletionInvocation({ ...base, documentRevision: 5, reason: "explicit" });
    // Caret move resets.
    expect(recordBasicCompletionInvocation({ ...base, documentRevision: 5, positionKey: "0:11", reason: "explicit" })).toBe(1);
    recordBasicCompletionInvocation({ ...base, documentRevision: 5, positionKey: "0:11", reason: "explicit" });
    // Provider restart (session generation change) resets even at one caret.
    expect(recordBasicCompletionInvocation({ ...base, documentRevision: 5, positionKey: "0:11", providerGeneration: 2, reason: "explicit" })).toBe(1);
    // Popup close ends the sequence entirely.
    resetBasicCompletionSession("ws", "f");
    expect(recordBasicCompletionInvocation({ ...base, documentRevision: 5, positionKey: "0:11", providerGeneration: 2, reason: "explicit" })).toBe(1);
  });

  it("maps requested scope to honest provider scope facts", () => {
    expect(providerScopeFor("default", false)).toBe("unknown");
    expect(providerScopeFor("default", true)).toBe("unknown");
    // LSP/jdtls has no expansion channel: expanded stays honestly unchanged.
    expect(providerScopeFor("expanded", false)).toBe("unchanged");
    expect(providerScopeFor("expanded", true)).toBe("expanded");
  });
});

describe("§8.19.4 invocation evidence ring", () => {
  it("records ordinal/scope facts and forwards them to fetch", async () => {
    resetCompletionTelemetry();
    const seenInvocations: Array<{ invocationOrdinal: number; requestedScope: string } | undefined> = [];
    const view = mountView("\nasL");
    const hooks = makeHooks({
      fetch: async (_position, _trigger, _token, invocation) => {
        seenInvocations.push(invocation ? { ...invocation } : undefined);
        return resultWith([makeItem()]);
      },
    });

    const first = await runSource(view, hooks);
    expect(seenInvocations[0]).toEqual({ invocationOrdinal: 1, requestedScope: "default" });

    const second = await runSource(view, hooks);
    expect(seenInvocations[1]).toEqual({ invocationOrdinal: 2, requestedScope: "expanded" });
    expect(first && second).toBeTruthy();

    const ring = recentCompletionInvocations();
    const lastTwo = ring.slice(-2);
    expect(lastTwo.map((entry) => entry.invocationOrdinal)).toEqual([1, 2]);
    expect(lastTwo.map((entry) => entry.requestedScope)).toEqual(["default", "expanded"]);
    // Honest default: jdtls cannot express scope expansion over standard LSP.
    expect(lastTwo.map((entry) => entry.providerScope)).toEqual(["unknown", "unchanged"]);
    expect(new Set(lastTwo.map((entry) => entry.reason))).toEqual(new Set(["explicit"]));
    expect(lastTwo[0].providerGeneration).toBe(IDENTITY.lspSessionGeneration);

    // A typing-triggered popup inherits the live sequence without advancing.
    const third = await runSource(view, hooks, 4, false);
    expect(third).not.toBeNull();
    expect(seenInvocations[2]?.invocationOrdinal).toBe(2);
    expect(recentCompletionInvocations().at(-1)?.invocationOrdinal).toBe(2);
    view.destroy();
  });
});

describe("§8.19.4 acceptance plan classifier", () => {
  it("classifies ready, needs-explicit-primary-only, stale and overlap dispositions", () => {
    const base = { identity: IDENTITY, item: makeItem() };
    expect(
      buildCompletionAcceptancePlanV2({
        ...base,
        resolveState: { kind: "ready", resolvedAt: 1, hasAdditionalEdits: true },
      }).disposition,
    ).toBe("ready");
    expect(
      buildCompletionAcceptancePlanV2({ ...base, resolveState: { kind: "timed-out", canRetry: true } }).disposition,
    ).toBe("needs-explicit-primary-only");
    expect(
      buildCompletionAcceptancePlanV2({
        ...base,
        resolveState: { kind: "failed", canRetry: true, message: "boom" },
      }).disposition,
    ).toBe("needs-explicit-primary-only");
    expect(buildCompletionAcceptancePlanV2({ ...base, resolveState: { kind: "stale" } }).disposition)
      .toBe("blocked-stale");
    expect(buildCompletionAcceptancePlanV2({ ...base, resolveState: { kind: "not-required" }, overlapRejected: true }).disposition)
      .toBe("blocked-overlap");

    const snippetPlan = buildCompletionAcceptancePlanV2({
      identity: IDENTITY,
      item: makeItem({
        label: "run",
        insertText: "run(${1:x});",
        insertTextFormat: 2,
        textEdit: null,
      }),
      resolveState: { kind: "not-required" },
    });
    expect(snippetPlan.snippet).toHaveLength(1);
    expect(snippetPlan.itemId).toBe(completionItemId(makeItem({ label: "run", insertText: "run(${1:x});", insertTextFormat: 2, textEdit: null })));
  });
});

describe("§8.19.4 resolve gate acceptance", () => {
  it("timeout presents the gate; Insert without import commits exactly the primary once", async () => {
    vi.useFakeTimers();
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    let resolveCalls = 0;
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => {
        resolveCalls += 1;
        return new Promise<LspCompletionItem | null>(() => {}); // hangs → 3s timeout
      },
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);

    await vi.advanceTimersByTimeAsync(3100);
    expect(gates).toHaveLength(1);
    expect(gates[0].reason).toBe("timeout");
    // Nothing inserted while waiting: the buffer still shows typed text only.
    expect(view.state.doc.toString()).toBe("\nasL");

    expect(gates[0].insertWithoutImport()).toBe(true);
    expect(view.state.doc.toString()).toBe("\nasList");
    // Settled gate refuses a second insertion.
    expect(gates[0].insertWithoutImport()).toBe(false);
    expect(view.state.doc.toString()).toBe("\nasList");
    expect(await gates[0].retry()).toBe("unavailable");
    expect(resolveCalls).toBe(1);
    view.destroy();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("failed resolve presents the gate; dismiss inserts nothing", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const diagnostics: Array<[string, string | undefined]> = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => {
        throw new Error("resolve exploded");
      },
      reportDiagnostic: (kind, detail) => diagnostics.push([kind, detail]),
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(gates).toHaveLength(1);
    expect(gates[0].reason).toBe("failed");
    gates[0].dismiss();
    await settle();
    expect(view.state.doc.toString()).toBe("\nasL");
    expect(diagnostics.some(([kind]) => kind === "additional-edit-unavailable")).toBe(true);
    view.destroy();
  });

  it("distinguishes a null resolve result as unavailable", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => null,
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(gates).toHaveLength(1);
    expect(gates[0].reason).toBe("unavailable");
    expect(view.state.doc.toString()).toBe("\nasL");
    view.destroy();
  });

  it("treats a missing resolver as unavailable and waits for explicit primary-only choice", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const source = createLspCompletionSource(makeHooks({
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(gates).toHaveLength(1);
    expect(gates[0].reason).toBe("unavailable");
    expect(gates[0].message).toContain("provider resolve is unavailable");
    expect(view.state.doc.toString()).toBe("\nasL");
    expect(await gates[0].retry()).toBe("unavailable");
    expect(view.state.doc.toString()).toBe("\nasL");
    expect(gates[0].insertWithoutImport()).toBe(true);
    expect(view.state.doc.toString()).toBe("\nasList");
    view.destroy();
  });

  it("retry performs a fresh resolve and lands import + primary as one dispatch/one undo", async () => {
    const view = mountView("\nasL");
    const originalDoc = view.state.doc.toString();
    const gates: CompletionResolveGateRequest[] = [];
    let attempts = 0;
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => {
        attempts += 1;
        if (attempts === 1) return null; // first attempt empty → gate
        return makeItem({
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import java.util.Arrays;\n",
          }],
        });
      },
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(gates).toHaveLength(1);
    const outcome = await gates[0].retry();
    expect(outcome).toBe("committed");
    expect(attempts).toBe(2);
    expect(view.state.doc.toString()).toBe("import java.util.Arrays;\n\nasList");
    // One undo removes the whole merged acceptance.
    undo(view);
    expect(view.state.doc.toString()).toBe(originalDoc);
    view.destroy();
  });

  it("retry failure keeps the gate open with an honest failed note", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => null,
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(await gates[0].retry()).toBe("unavailable");
    expect(view.state.doc.toString()).toBe("\nasL");
    // The gate closures are not settled by a failed retry: the user can still
    // choose primary-only afterwards.
    expect(gates[0].insertWithoutImport()).toBe(true);
    expect(view.state.doc.toString()).toBe("\nasList");
    view.destroy();
  });

  it("blocks stale gate actions after the buffer moved on", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const diagnostics: Array<[string, string | undefined]> = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => null,
      reportDiagnostic: (kind, detail) => diagnostics.push([kind, detail]),
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();
    expect(gates).toHaveLength(1);

    // User kept typing while the banner was up: the gate becomes inert.
    view.dispatch({ changes: { from: 4, to: 4, insert: "X" } });
    expect(gates[0].insertWithoutImport()).toBe(false);
    expect(view.state.doc.toString()).toBe("\nasLX");
    expect(await gates[0].retry()).toBe("unavailable");
    expect(diagnostics.some(([kind]) => kind === "identity-mismatch")).toBe(true);
    view.destroy();
  });

  it("overlapping provider edits block the whole acceptance instead of partial apply", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const diagnostics: Array<[string, string | undefined]> = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => makeItem({
        // Overlaps the primary span [1,0)-[1,3): must reject the entire item.
        additionalTextEdits: [{
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } },
          newText: "XX",
        }],
      }),
      reportDiagnostic: (kind, detail) => diagnostics.push([kind, detail]),
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(view.state.doc.toString()).toBe("\nasL");
    expect(gates).toHaveLength(0);
    expect(diagnostics.some(([kind]) => kind === "invalid-additional-edits")).toBe(true);
    view.destroy();
  });

  it("without a gate surface a failing resolve blocks instead of silently inserting", async () => {
    const view = mountView("\nasL");
    const diagnostics: Array<[string, string | undefined]> = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => null,
      reportDiagnostic: (kind, detail) => diagnostics.push([kind, detail]),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(view.state.doc.toString()).toBe("\nasL");
    expect(diagnostics.some(([kind, detail]) => kind === "additional-edit-unavailable" && !!detail)).toBe(true);
    view.destroy();
  });

  it("successful resolve commits the merged acceptance without any gate", async () => {
    const view = mountView("\nasL");
    const gates: CompletionResolveGateRequest[] = [];
    const source = createLspCompletionSource(makeHooks({
      resolve: async () => makeItem({
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import java.util.Arrays;\n",
        }],
      }),
      onResolveGate: (request) => gates.push(request),
    }));
    const result = await source(new CompletionContext(view.state, 4, true));
    applyFirstOption(view, result);
    await settle();

    expect(gates).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("import java.util.Arrays;\n\nasList");
    view.destroy();
  });
});

describe("§ED-COMP-001: Typed Completion Resolve Outcomes", () => {
  const token: CompletionRequestToken = {
    workspaceId: "ws-r3",
    fileKey: "A.java",
    filePath: "/repo/A.java",
    uri: "file:///repo/A.java",
    languageId: "java",
    documentRevision: 7,
    lspSessionGeneration: 3,
    requestId: "req-1",
  };

  it("classifies all 7 typed outcomes accurately", () => {
    const item = makeItem();

    // 1. resolved
    const resolvedItem = makeItem({
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import java.util.List;\n",
      }],
    });
    const resolved = classifyCompletionResolveOutcome({ item, hasResolver: true, resolvedItem });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") {
      expect(resolved.edits).toHaveLength(1);
    }

    // 2. not-required
    const notReqItem = makeItem({
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import java.util.List;\n",
      }],
    });
    const notRequired = classifyCompletionResolveOutcome({ item: notReqItem, hasResolver: false });
    expect(notRequired.kind).toBe("not-required");

    // 3. unavailable (resolver 缺失不推导 not-required)
    const missingResolver = classifyCompletionResolveOutcome({ item, hasResolver: false });
    expect(missingResolver.kind).toBe("unavailable");
    if (missingResolver.kind === "unavailable") {
      expect(missingResolver.reason).toBe("missing-resolver");
    }

    const resolverReturnedNull = classifyCompletionResolveOutcome({ item, hasResolver: true, resolvedItem: null });
    expect(resolverReturnedNull.kind).toBe("unavailable");
    if (resolverReturnedNull.kind === "unavailable") {
      expect(resolverReturnedNull.reason).toBe("resolver-returned-null");
    }

    // 4. timeout
    const timeout = classifyCompletionResolveOutcome({ item, hasResolver: true, timedOut: true });
    expect(timeout.kind).toBe("timeout");

    // 5. failed
    const failed = classifyCompletionResolveOutcome({ item, hasResolver: true, error: new Error("network down") });
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.error).toBe("network down");
    }

    // 6. cancelled
    const cancelled = classifyCompletionResolveOutcome({ item, hasResolver: true, cancelled: true });
    expect(cancelled.kind).toBe("cancelled");

    // 7. stale
    const stale = classifyCompletionResolveOutcome({
      item,
      hasResolver: true,
      isStale: true,
      tokenRevision: 7,
      currentRevision: 8,
    });
    expect(stale.kind).toBe("stale");
    if (stale.kind === "stale") {
      expect(stale.expectedRevision).toBe(7);
      expect(stale.currentRevision).toBe(8);
    }
  });

  it("executeCompletionResolve handles timeout, throw, null, cancel, and revision drift safely", async () => {
    vi.useFakeTimers();
    const item = makeItem();

    // Missing resolver returns unavailable
    const missing = await executeCompletionResolve({
      item,
      token,
      isStillCurrent: () => true,
    });
    expect(missing.kind).toBe("unavailable");

    // Throw returns failed
    const throwResult = await executeCompletionResolve({
      item,
      resolve: async () => { throw new Error("lsp crashed"); },
      token,
      isStillCurrent: () => true,
    });
    expect(throwResult.kind).toBe("failed");

    // Null returns unavailable
    const nullResult = await executeCompletionResolve({
      item,
      resolve: async () => null,
      token,
      isStillCurrent: () => true,
    });
    expect(nullResult.kind).toBe("unavailable");

    // Cancel via AbortSignal returns cancelled
    const controller = new AbortController();
    controller.abort();
    const cancelResult = await executeCompletionResolve({
      item,
      resolve: async () => makeItem(),
      token,
      isStillCurrent: () => true,
      signal: controller.signal,
    });
    expect(cancelResult.kind).toBe("cancelled");

    // Stale revision returns stale
    let docRev = 7;
    const stalePromise = executeCompletionResolve({
      item,
      resolve: async () => {
        docRev = 8; // User typed!
        return makeItem();
      },
      token,
      isStillCurrent: () => true,
      getDocumentRevision: () => docRev,
    });
    const staleResult = await stalePromise;
    expect(staleResult.kind).toBe("stale");

    // Timeout returns timeout
    const timeoutPromise = executeCompletionResolve({
      item,
      resolve: async () => new Promise<LspCompletionItem | null>(() => {}),
      token,
      isStillCurrent: () => true,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    const timeoutResult = await timeoutPromise;
    expect(timeoutResult.kind).toBe("timeout");
  });
});

describe("§ED-COMP-003: Atomic Acceptance & Single Undo", () => {
  const token: CompletionRequestToken = {
    workspaceId: "ws-r3",
    fileKey: "A.java",
    filePath: "/repo/A.java",
    uri: "file:///repo/A.java",
    languageId: "java",
    documentRevision: 7,
    lspSessionGeneration: 3,
    requestId: "req-1",
  };

  it("plans changes and detects overlapping or out-of-order edits with zero mutation", () => {
    const view = mountView("class App {\n  void main() {\n    Lis\n  }\n}");
    const primary = { from: 31, to: 34, insert: "List" };

    // Valid non-overlapping import edit at line 0
    const validEdit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "import java.util.List;\n",
    };
    const validPlan = planCompletionChanges(view, primary, [validEdit]);
    expect(validPlan.ok).toBe(true);
    expect(validPlan.list).toHaveLength(2);
    expect(validPlan.list[0].from).toBe(0); // import first
    expect(validPlan.list[1].from).toBe(31); // primary second

    // Overlapping edit colliding with primary span
    const overlappingEdit = {
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 6 } },
      newText: "List",
    };
    const badPlan = planCompletionChanges(view, primary, [overlappingEdit]);
    expect(badPlan.ok).toBe(false);
    view.destroy();
  });

  it("commits snippet with preceding auto-import in exactly one dispatch and reverts in exactly one undo", () => {
    const view = mountView("class App {\n  void main() {\n    Lis\n  }\n}");
    const initialDoc = view.state.doc.toString();
    const item = makeItem({
      label: "List",
      insertText: "List<${1:String}>",
      insertTextFormat: 2,
      textEdit: null,
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import java.util.List;\n",
      }],
    });

    const dispatchSpy = vi.spyOn(view, "dispatch");
    const diagnostics: string[] = [];
    const committed = commitLspCompletion(
      view,
      item,
      31,
      34,
      token,
      () => true,
      (diag) => diagnostics.push(diag),
    );

    expect(committed).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(0);

    const docAfter = view.state.doc.toString();
    expect(docAfter).toContain("import java.util.List;\nclass App");
    expect(docAfter).toContain("List<String>");

    // Exactly one undo reverts everything back to initial document
    undo(view);
    expect(view.state.doc.toString()).toBe(initialDoc);
    view.destroy();
  });

  it("rejects stale token without any document dispatch", () => {
    const view = mountView("class App {\n  void main() {\n    Lis\n  }\n}");
    const initialDoc = view.state.doc.toString();
    const item = makeItem({ label: "List" });
    const diagnostics: string[] = [];

    const committed = commitLspCompletion(
      view,
      item,
      31,
      34,
      token,
      () => false, // Token is stale!
      (diag) => diagnostics.push(diag),
    );

    expect(committed).toBe(false);
    expect(diagnostics).toContain("identity-mismatch");
    expect(view.state.doc.toString()).toBe(initialDoc);
    view.destroy();
  });
});
