import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../stores/codeWorkspaceStore";
import { useProjectFactsStore } from "../../stores/projectFactsStore";
import { useAppStore } from "../../stores/appStore";
import { CodeWorkspaceTab } from "./CodeWorkspaceTab";
import { loadJavaTemplatePreferences, resetJavaTemplatePreferences } from "../../lib/fileTemplatePreferences";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
  workspaceDetectGitRoots: vi.fn(),
  workspaceDetectTasks: vi.fn(),
  workspaceExecutionModel: vi.fn(),
  workspaceJavaRunTargets: vi.fn(),
  workspaceJavaRunTarget: vi.fn(),
  workspaceTaskTree: vi.fn(),
  workspaceTestResults: vi.fn(),
  workspaceDependencyTree: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceReadLooseFile: vi.fn(),
  workspaceReadFileWithEncoding: vi.fn(),
  workspaceReadLooseFileWithEncoding: vi.fn(),
  workspaceWriteFile: vi.fn(),
  workspaceWriteLooseFile: vi.fn(),
  workspaceWriteFileEncoded: vi.fn(),
  workspaceWriteLooseFileEncoded: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceDeleteFile: vi.fn(),
  workspaceDeleteDir: vi.fn(),
  workspaceCreateDir: vi.fn(),
  workspaceRenamePath: vi.fn(),
  workspaceCopyPath: vi.fn(),
  workspaceRevealInFinder: vi.fn(),
  workspaceOpenTerminalAt: vi.fn(),
  workspaceGitSnapshot: vi.fn(),
  workspaceGitLineChanges: vi.fn(),
  workspaceGitFileChanges: vi.fn(),
  workspaceGitRestoreRange: vi.fn(),
  workspaceGitRollback: vi.fn(),
  workspaceGitStageFile: vi.fn(),
  workspaceGitUnstageFile: vi.fn(),
  workspaceGitDiscardFile: vi.fn(),
  workspaceGitCommit: vi.fn(),
  workspaceGitPush: vi.fn(),
  workspaceGitPull: vi.fn(),
  workspaceGitFetch: vi.fn(),
  workspaceGitBranchList: vi.fn(),
  workspaceGitCreateBranch: vi.fn(),
  workspaceGitCheckoutBranch: vi.fn(),
  workspaceGitLog: vi.fn(),
  workspaceGitFileHistory: vi.fn(),
  workspaceGitStatus: vi.fn(),
  workspaceGitResolveConflicts: vi.fn(),
  workspaceGitDiff: vi.fn(),
  workspaceSearchStart: vi.fn(),
  workspaceSearchCancel: vi.fn(),
  workspaceApplyResourceOperation: vi.fn(),
}));

const lspMocks = vi.hoisted(() => ({
  lspStopWorkspace: vi.fn(async () => 0),
  lspStopWorkspaceWatcher: vi.fn(async () => undefined),
  lspSaveDocument: vi.fn(async () => undefined),
  lspCloseDocument: vi.fn(async () => undefined),
  lspWorkspaceDidFileOperation: vi.fn(async () => null),
  lspWorkspaceWillFileOperation: vi.fn(async () => null),
  lspGetDiagnostics: vi.fn(async () => []),
}));

vi.mock("../../lib/editor/lsp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/editor/lsp")>();
  return {
    ...actual,
    ...lspMocks,
  };
});

vi.mock("../../hooks/useProjectDescriptorDiscovery", () => ({
  useProjectDescriptorDiscovery: () => ({
    status: "ready",
    discovery: null,
    reason: null,
    refresh: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../lib/editor/workspace", () => {
  const wrapResult = (value: unknown): unknown => {
    if (value && typeof value === "object" && "state" in (value as Record<string, unknown>)) return value;
    if (Array.isArray(value)) return { state: "ready", entries: value, truncated: false };
    if (value && typeof value === "object" && "path" in (value as Record<string, unknown>)
      && "entries" in (value as Record<string, unknown>)) {
      return { state: "ready", entries: (value as { entries: unknown[] }).entries, truncated: false };
    }
    return { state: "failed", message: "malformed fixture payload" };
  };
  const wrap = async (fn: () => unknown): Promise<unknown> => {
    try {
      return wrapResult(await fn());
    } catch (error) {
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    ...workspaceMocks,
    workspaceListDir: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceListDir(...args)),
    workspaceCompactChain: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceCompactChain(...args)),
    workspaceListFilesRecursive: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceListFilesRecursive(...args)),
    absoluteWorkspacePath: (root: { path: string }, rel: string) => `${root.path}/${rel}`,
    relativePathWithinRoot: (rootPath: string, absPath: string) => {
      const normRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
      const normAbs = absPath.replace(/\\/g, "/");
      if (normAbs === normRoot) return "";
      if (normAbs.startsWith(normRoot + "/")) return normAbs.slice(normRoot.length + 1);
      return null;
    },
    isPathContainedInRoot: (candidate: string, rootPath: string) => {
      const normRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
      const normCand = candidate.replace(/\\/g, "/");
      return normCand === normRoot || normCand.startsWith(normRoot + "/");
    },
    basename: (p: string) => p.split("/").filter(Boolean).pop() ?? "",
    parentPath: (p: string) => {
      const parts = p.split("/").filter(Boolean);
      parts.pop();
      return parts.join("/");
    },
  };
});

vi.mock("../../lib/editor/workspaceTooling", () => ({
  workspaceIngestMavenProject: vi.fn(async () => ({
    status: "ready",
    modules: [],
    provenance: null,
    errorMessage: null,
  })),
  workspaceIngestGradleProject: vi.fn(async () => ({
    status: "ready",
    modules: [],
    provenance: null,
    errorMessage: null,
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../../lib/appDialogs", () => ({
  promptAppDialog: vi.fn(),
  confirmAppDialog: vi.fn(async () => true),
  alertAppDialog: vi.fn(async () => undefined),
}));

describe("ED-TEMPLATE-001: File and Code Templates production flow in CodeWorkspaceTab", () => {
  const workspaceRoot = "/workspace/demo-app";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetJavaTemplatePreferences();

    const disk = new Map<string, string>();
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, dir = "") => {
      const entries = [];
      const normDir = dir ? (dir.endsWith("/") ? dir : `${dir}/`) : "";
      const seen = new Set<string>();
      for (const filePath of disk.keys()) {
        if (!normDir || filePath.startsWith(normDir)) {
          const sub = normDir ? filePath.slice(normDir.length) : filePath;
          const parts = sub.split("/");
          const name = parts[0];
          if (!seen.has(name)) {
            seen.add(name);
            const isDir = parts.length > 1;
            const fullRelPath = normDir ? `${normDir}${name}` : name;
            entries.push({
              name,
              path: fullRelPath,
              fileType: isDir ? "directory" : "file",
              size: isDir ? 0 : (disk.get(filePath)?.length ?? 0),
              modifiedAt: Date.now(),
              children: [],
            });
          }
        }
      }
      return entries;
    });

    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path) ?? "";
      return {
        text,
        hash: `h-${text.length}`,
        encoding: "UTF-8",
        bom: false,
      };
    });

    workspaceMocks.workspaceCompactChain.mockResolvedValue([]);
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([]);
    workspaceMocks.workspaceCreateFile.mockImplementation(async (_rootPath: string, path: string) => ({
      name: path.split("/").pop() ?? "NewClass.java",
      path,
      isDirectory: false,
      size: 0,
      modifiedAt: Date.now(),
    }));
    workspaceMocks.workspaceWriteFile.mockResolvedValue({ hash: "h1" });
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (_root: string, path: string, text: string) => {
      disk.set(path, text);
      return { hash: `h-${text.length}`, bytesWritten: text.length };
    });
    workspaceMocks.workspaceDeleteFile.mockResolvedValue(undefined);
    workspaceMocks.workspaceApplyResourceOperation.mockImplementation(async (_root: string, op: any) => {
      if (op.kind === "create" && op.path) {
        if (!disk.has(op.path)) disk.set(op.path, "");
      } else if (op.kind === "delete" && op.path) {
        disk.delete(op.path);
      }
      return { ignored: false };
    });
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [],
      buildTargets: [],
      runConfigurations: [],
      debugConfigurations: [],
      tools: [],
    });
    workspaceMocks.workspaceJavaRunTargets.mockResolvedValue([]);
    workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:fixture",
      label: "Fixture",
      mainClass: "Fixture",
      filePath: `${workspaceRoot}/Fixture.java`,
      command: "java Fixture",
      cwd: workspaceRoot,
      buildSystem: "source-file",
      modulePath: ".",
    });
    workspaceMocks.workspaceTaskTree.mockResolvedValue([]);

    // Setup ready project facts with a Java source root
    useProjectFactsStore.setState({
      workspaces: {
        [workspaceRoot]: {
          workspaceRoot,
          generation: 1,
          status: "ready",
          reason: null,
          fingerprint: "fp-test",
          structure: {
            projectFingerprint: "fp-test",
            generation: 1,
            modules: [
              {
                id: "demo-module",
                name: "demo",
                root: workspaceRoot,
                sourceSets: [
                  {
                    kind: "main",
                    roots: [`${workspaceRoot}/src/main/java`],
                  },
                ],
                classpathFingerprint: "cp-1",
                dependencies: [],
              },
            ],
            excludedRoots: [],
            facts: {},
            completeness: { level: "complete", missing: [] },
          },
          provenance: null,
          isStale: false,
        },
      },
    });

    useCodeWorkspaceStore.setState({ byInstanceId: {} });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const workspaceInfo = {
    repoRoot: workspaceRoot,
    workspaceId: "ws-template-test",
    workspaceInstanceId: "ws-template-test",
    name: "demo-app",
    roots: [
      {
        id: "root-1",
        name: "demo-app",
        path: workspaceRoot,
        kind: "folder" as const,
      },
    ],
  };

  const captureCommands = () => {
    const registrationRef: { current: any } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: any) => {
      if (next) registrationRef.current = next;
    });
    return { registrationRef, onCommandsChange };
  };

  it("opens NewJavaClassDialog via workspace.tree.newJavaClass and creates class in package (ED-TEMPLATE-001-A1)", async () => {
    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    // Trigger command workspace.tree.newJavaClass targeting a package directory
    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    // Dialog should open
    expect(await screen.findByTestId("new-java-class-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("new-java-class-package")).toHaveTextContent("com.example.service");

    // Enter name
    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "CustomerService" } });

    // Submit
    const submitBtn = screen.getByTestId("new-java-class-submit");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Verify workspaceApplyResourceOperation was called with target path
    await waitFor(() => {
      expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith(
        workspaceRoot,
        expect.objectContaining({
          kind: "create",
          path: "src/main/java/com/example/service/CustomerService.java",
        }),
      );
    });

    // Verify workspaceWriteFileEncoded was called with rendered template content containing package and class
    expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      workspaceRoot,
      "src/main/java/com/example/service/CustomerService.java",
      expect.stringContaining("package com.example.service;"),
      expect.anything(),
      "UTF-8",
      false,
    );
    expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      workspaceRoot,
      "src/main/java/com/example/service/CustomerService.java",
      expect.stringContaining("public class CustomerService {"),
      expect.anything(),
      "UTF-8",
      false,
    );
  });

  it("prevents file creation when name is invalid or conflicts (ED-TEMPLATE-001-A2)", async () => {
    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    expect(await screen.findByTestId("new-java-class-dialog")).toBeInTheDocument();

    const input = screen.getByTestId("new-java-class-name-input");
    // Invalid Java keyword
    fireEvent.change(input, { target: { value: "interface" } });

    const submitBtn = screen.getByTestId("new-java-class-submit");
    expect(submitBtn).toBeDisabled();
    expect(screen.getByTestId("new-java-class-error")).toHaveTextContent("reserved Java keyword");

    expect(workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });

  it("blocks file creation while project facts are not ready (ED-TEMPLATE-001-A2)", async () => {
    useProjectFactsStore.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceRoot]: {
          ...state.workspaces[workspaceRoot]!,
          status: "loading",
          reason: "Loading project build facts...",
          structure: null,
        },
      },
    }));

    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    fireEvent.change(await screen.findByTestId("new-java-class-name-input"), {
      target: { value: "UnavailableService" },
    });

    expect(screen.getByTestId("new-java-class-submit")).toBeDisabled();
    expect(screen.getByTestId("new-java-class-error")).toHaveTextContent("ready status required");
    expect(workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });

  it("rejects a plan when project facts become stale before creation (ED-TEMPLATE-001-A2)", async () => {
    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    fireEvent.change(await screen.findByTestId("new-java-class-name-input"), {
      target: { value: "StaleService" },
    });
    useProjectFactsStore.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceRoot]: {
          ...state.workspaces[workspaceRoot]!,
          generation: 2,
          isStale: true,
          reason: "Project configuration modified",
        },
      },
    }));

    await act(async () => {
      fireEvent.click(screen.getByTestId("new-java-class-submit"));
    });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("project facts changed"));
    expect(workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });

  it("reports resource write failure without false success and keeps one undo recovery (ED-TEMPLATE-001-A2/A3)", async () => {
    workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(new Error("disk is read-only"));
    workspaceMocks.workspaceWriteLooseFileEncoded.mockRejectedValue(new Error("disk is read-only"));

    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    fireEvent.change(await screen.findByTestId("new-java-class-name-input"), {
      target: { value: "FailedService" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("new-java-class-submit"));
    });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Could not create FailedService.java"));
    expect(screen.getByTestId("new-java-class-dialog")).toBeInTheDocument();
    expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalled();

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.undoWorkspaceEdit");
    });

    await waitFor(() => {
      expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith(
        workspaceRoot,
        expect.objectContaining({
          kind: "delete",
          path: "src/main/java/com/example/service/FailedService.java",
        }),
      );
    });
  });

  it("supports undo to remove created Java file (ED-TEMPLATE-001-A3)", async () => {
    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.tree.newJavaClass", {
        directory: { rootId: "root-1", path: "src/main/java/com/example/service" },
      });
    });

    expect(await screen.findByTestId("new-java-class-dialog")).toBeInTheDocument();

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "TemporaryRecord" } });

    const kindSelect = screen.getByTestId("new-java-class-kind-select");
    fireEvent.change(kindSelect, { target: { value: "record" } });

    const submitBtn = screen.getByTestId("new-java-class-submit");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith(
        workspaceRoot,
        expect.objectContaining({
          kind: "create",
          path: "src/main/java/com/example/service/TemporaryRecord.java",
        }),
      );
    });

    // Now execute undo
    await act(async () => {
      await registrationRef.current!.executeAction("workspace.undoWorkspaceEdit");
    });

    // Undo calls delete on the created file via workspaceApplyResourceOperation
    await waitFor(() => {
      expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith(
        workspaceRoot,
        expect.objectContaining({
          kind: "delete",
          path: "src/main/java/com/example/service/TemporaryRecord.java",
        }),
      );
    });
  });

  it("opens FileTemplateSettingsDialog and persists edited templates (ED-TEMPLATE-001-A4)", async () => {
    const { registrationRef, onCommandsChange } = captureCommands();
    render(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspaceInfo}
        visible={true}
        onCommandsChange={onCommandsChange}
      />,
    );
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    await act(async () => {
      await registrationRef.current!.executeAction("workspace.fileTemplateSettings");
    });

    expect(await screen.findByTestId("file-template-settings-dialog")).toBeInTheDocument();

    const textarea = screen.getByTestId("file-template-editor-textarea");
    fireEvent.change(textarea, {
      target: { value: "package ${PACKAGE_NAME};\n\n// Enterprise Header\npublic class ${NAME} {}" },
    });

    const saveBtn = screen.getByTestId("file-template-save-button");
    fireEvent.click(saveBtn);

    const prefs = loadJavaTemplatePreferences();
    expect(prefs.templates.class).toContain("// Enterprise Header");
  });
});
