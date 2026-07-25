import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingSettingsSection, openSettingsSection } from "../../lib/settingsNavigation";
import { LanguageServersSettings } from "./LanguageServersSettings";

const writeTextMock = vi.fn(async (_text: string) => {});
const detectMock = vi.fn();
const setJavaHomeMock = vi.fn(async (_home?: string | null) => {});
const setJavaVmargsMock = vi.fn(async (vmargs?: string | null) => vmargs?.trim() || "-Xms1024m -Xmx1024m");
const setJavaSettingsMock = vi.fn(async (_settings: unknown) => 0);
const setJavaBundlesMock = vi.fn(async (_config: unknown) => {});
const detectJavaBundlesMock = vi.fn(async () => [] as unknown[]);
const selectFolderPathMock = vi.fn(async (_current?: string) => null as string | null);

vi.mock("../../lib/clipboard", () => ({
  writeText: (text: string) => writeTextMock(text),
}));

vi.mock("../../lib/editor/lsp", () => ({
  lspDetectServers: (options?: { javaHome?: string | null }) => detectMock(options),
  lspSetJavaHome: (javaHome?: string | null) => setJavaHomeMock(javaHome),
  lspSetJavaVmargs: (vmargs?: string | null) => setJavaVmargsMock(vmargs),
  lspSetJavaSettings: (settings: unknown) => setJavaSettingsMock(settings),
  lspSetJavaBundles: (config: unknown) => setJavaBundlesMock(config),
  lspDetectJavaBundles: () => detectJavaBundlesMock(),
}));

vi.mock("../../lib/ipc", () => ({
  selectFolderPath: (current?: string) => selectFolderPathMock(current),
}));

vi.mock("../../lib/i18n", () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (params) return `${key}:${JSON.stringify(params)}`;
    return key;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  clearPendingSettingsSection();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  detectMock.mockResolvedValue([
    {
      presetId: "java",
      displayName: "Java",
      documentLanguageIds: ["java"],
      available: false,
      active: false,
      selectedCommandId: "jdtls",
      selectedCommand: "jdtls",
      installHint: "Requires JDK 21+. Linux: …",
      error:
        "jdtls requires Java 21+ (current Eclipse JDT LS); found Java 17 at C:\\Program Files\\Java\\jdk-17\\bin\\java.exe",
      runtimeStatus: "Java 17 — need JDK 21+ for current JDT LS",
      commands: [
        {
          id: "jdtls",
          label: "jdtls",
          command: "jdtls",
          args: [],
          installHint: "Requires JDK 21+. Linux: …",
          fallback: false,
          available: true,
        },
      ],
    },
    {
      presetId: "rust",
      displayName: "Rust",
      documentLanguageIds: ["rust"],
      available: true,
      active: false,
      selectedCommandId: "rust-analyzer",
      selectedCommand: "rust-analyzer",
      installHint: "rustup component add rust-analyzer",
      error: null,
      runtimeStatus: null,
      commands: [
        {
          id: "rust-analyzer",
          label: "rust-analyzer",
          command: "rust-analyzer",
          args: [],
          installHint: "rustup component add rust-analyzer",
          fallback: false,
          available: true,
        },
      ],
    },
  ]);
});

describe("LanguageServersSettings", () => {
  it("lists servers and keeps install commands collapsed by default", async () => {
    render(<LanguageServersSettings />);
    expect(await screen.findByTestId("language-server-row-java")).toBeInTheDocument();
    expect(screen.getByTestId("language-server-row-rust")).toBeInTheDocument();
    // Collapsed: no install command body visible.
    expect(screen.queryByTestId("language-servers-install-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("brew install jdtls")).not.toBeInTheDocument();
    // Both missing and installed servers expose a show-install control.
    expect(screen.getAllByTestId("language-servers-install-toggle")).toHaveLength(2);
  });

  it("surfaces Java runtime version status and JDK 21 requirement for jdtls", async () => {
    render(<LanguageServersSettings />);
    const runtime = await screen.findByTestId("language-server-runtime-java");
    expect(runtime).toHaveAttribute("data-ok", "false");
    expect(runtime).toHaveTextContent(/Java 17/);
    expect(runtime).toHaveTextContent(/JDK 21/);
    expect(screen.getByTestId("language-server-error-java")).toHaveTextContent(
      /requires Java 21/i,
    );
    // Subtitle / permanent note for the Java row.
    expect(runtime).toHaveTextContent("settings.languageServersJavaRequirement");
  });

  it("expands multi-OS install commands for jdtls with real URLs and copies the script", async () => {
    render(<LanguageServersSettings />);
    const javaRow = await screen.findByTestId("language-server-row-java");
    const toggle = javaRow.querySelector(
      "[data-testid='language-servers-install-toggle']",
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    expect(await screen.findByTestId("language-servers-install-panel")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-linux")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-macos")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-windows")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-note-linux")).toHaveTextContent(/JDK 21/i);
    expect(screen.getAllByText(/jdt-language-server-latest\.tar\.gz/).length).toBeGreaterThan(0);
    expect(screen.getByText(/brew install jdtls/)).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-hint")).toHaveTextContent("config_linux");

    fireEvent.click(screen.getByTestId("language-servers-copy-install-macos"));
    expect(writeTextMock).toHaveBeenCalled();
    const copied = String(writeTextMock.mock.calls[0][0]);
    expect(copied).toContain("brew install jdtls");
  });

  it("shows install commands for already-installed servers as a single shared line", async () => {
    render(<LanguageServersSettings />);
    const rustRow = await screen.findByTestId("language-server-row-rust");
    fireEvent.click(rustRow.querySelector(
      "[data-testid='language-servers-install-toggle']",
    ) as HTMLButtonElement);

    expect(await screen.findByTestId("language-servers-install-panel")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-shared")).toBeInTheDocument();
    expect(screen.getByText(/rustup component add rust-analyzer/)).toBeInTheDocument();
    // Shared catalog entry → no OS labels.
    expect(screen.queryByTestId("language-servers-install-line-linux")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("language-servers-copy-install-shared"));
    expect(writeTextMock).toHaveBeenCalled();
    expect(String(writeTextMock.mock.calls[0][0])).toContain("rustup component add rust-analyzer");
  });

  it("scrolls to and highlights the requested language server preset", async () => {
    openSettingsSection("language-servers", { presetId: "java" });
    render(<LanguageServersSettings />);

    const javaRow = await screen.findByTestId("language-server-row-java");
    await waitFor(() => {
      expect(javaRow).toHaveAttribute("data-focused", "true");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
    expect(await screen.findByTestId("language-servers-install-panel")).toBeInTheDocument();
  });

  it("persists command preference selection", async () => {
    render(<LanguageServersSettings />);
    const select = await screen.findByLabelText("Java language server command");
    fireEvent.change(select, { target: { value: "__custom__" } });
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspCommandPrefs.v1")).toBe(
        JSON.stringify({ java: "__custom__" }),
      );
    });
    fireEvent.change(screen.getByLabelText("Java custom command"), {
      target: { value: "/opt/jdtls/bin/jdtls" },
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspCustomCommands.v1")).toContain(
        "/opt/jdtls/bin/jdtls",
      );
    });
  });

  it("persists Java 21 runtime path and re-detects with that home", async () => {
    render(<LanguageServersSettings />);
    const input = await screen.findByTestId("language-servers-java-home");
    fireEvent.change(input, { target: { value: "C:\\Program Files\\Java\\jdk-21" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaHome.v1")).toBe(
        "C:\\Program Files\\Java\\jdk-21",
      );
    });
    await waitFor(() => {
      expect(setJavaHomeMock).toHaveBeenCalledWith("C:\\Program Files\\Java\\jdk-21");
      expect(detectMock).toHaveBeenCalledWith({
        javaHome: "C:\\Program Files\\Java\\jdk-21",
      });
    });

    selectFolderPathMock.mockResolvedValueOnce("D:\\jdks\\jdk-21.0.2");
    fireEvent.click(screen.getByTestId("language-servers-java-home-browse"));
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaHome.v1")).toBe(
        "D:\\jdks\\jdk-21.0.2",
      );
    });

    fireEvent.click(screen.getByTestId("language-servers-java-home-clear"));
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaHome.v1")).toBeNull();
      expect(setJavaHomeMock).toHaveBeenCalledWith(null);
    });
  });

  it("persists free-form jdtls JVM args and pushes them to the backend", async () => {
    render(<LanguageServersSettings />);
    const input = await screen.findByTestId("language-servers-java-vmargs");
    expect(input).toHaveValue("-Xms1024m -Xmx1024m");

    fireEvent.change(input, {
      target: { value: "-Xmx2G -XX:+UseG1GC -Dlog.level=ALL" },
    });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaVmargs.v1")).toBe(
        "-Xmx2G -XX:+UseG1GC -Dlog.level=ALL",
      );
    });
    await waitFor(() => {
      expect(setJavaVmargsMock).toHaveBeenCalledWith("-Xmx2G -XX:+UseG1GC -Dlog.level=ALL");
    });

    fireEvent.click(screen.getByTestId("language-servers-java-vmargs-clear"));
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaVmargs.v1")).toBeNull();
      expect(setJavaVmargsMock).toHaveBeenCalledWith("-Xms1024m -Xmx1024m");
      expect(input).toHaveValue("-Xms1024m -Xmx1024m");
    });
  });

  it("migrates the legacy heap-MB preference into JVM args on load", async () => {
    window.localStorage.setItem("taomni.codeWorkspace.lspJavaHeapMb.v1", "2048");
    render(<LanguageServersSettings />);
    const input = await screen.findByTestId("language-servers-java-vmargs");
    expect(input).toHaveValue("-Xms2048m -Xmx2048m");
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaVmargs.v1")).toBe(
      "-Xms2048m -Xmx2048m",
    );
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaHeapMb.v1")).toBeNull();
  });

  it("persists Java language settings and hot-applies them to jdtls", async () => {
    render(<LanguageServersSettings />);

    // Toggling save-organize-imports persists and pushes to the backend.
    const organizeImports = await screen.findByTestId("language-servers-java-organize-imports");
    expect(organizeImports).not.toBeChecked();
    fireEvent.click(organizeImports);

    await waitFor(() => {
      const stored = window.localStorage.getItem("taomni.codeWorkspace.lspJavaSettings.v1");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored ?? "{}").saveActionsOrganizeImports).toBe(true);
    });
    await waitFor(() => {
      expect(setJavaSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ saveActionsOrganizeImports: true }),
      );
    });

    // Enabling Lombok reveals the jar-path field; committing it persists.
    fireEvent.click(screen.getByTestId("language-servers-java-lombok"));
    const jarInput = await screen.findByTestId("language-servers-java-lombok-jar");
    fireEvent.change(jarInput, { target: { value: "/opt/lombok.jar" } });
    fireEvent.blur(jarInput);

    await waitFor(() => {
      const parsed = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.lspJavaSettings.v1") ?? "{}",
      );
      expect(parsed.lombokEnabled).toBe(true);
      expect(parsed.lombokJarPath).toBe("/opt/lombok.jar");
    });
  });

  it("parses import order from a comma-separated field", async () => {
    render(<LanguageServersSettings />);
    const input = await screen.findByTestId("language-servers-java-import-order");
    fireEvent.change(input, { target: { value: " java , javax, com ,, org " } });
    fireEvent.blur(input);

    await waitFor(() => {
      const parsed = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.lspJavaSettings.v1") ?? "{}",
      );
      expect(parsed.completionImportOrder).toEqual(["java", "javax", "com", "org"]);
    });
  });

  it("persists jdtls extension bundle paths and re-probes (M8)", async () => {
    detectJavaBundlesMock.mockResolvedValue([
      { id: "javaDebug", path: "/opt/java-debug/plugin.jar", available: true },
      { id: "javaTest", path: null, available: false },
    ]);
    render(<LanguageServersSettings />);

    const debugInput = await screen.findByTestId("language-servers-bundle-javaDebug");
    fireEvent.change(debugInput, { target: { value: "/opt/java-debug" } });
    fireEvent.blur(debugInput);

    await waitFor(() => {
      const parsed = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.lspJavaBundles.v1") ?? "{}",
      );
      expect(parsed.javaDebugPath).toBe("/opt/java-debug");
    });
    await waitFor(() => expect(setJavaBundlesMock).toHaveBeenCalledWith(
      expect.objectContaining({ javaDebugPath: "/opt/java-debug" }),
    ));
    // Probe status renders after the commit re-probe.
    await screen.findByTestId("language-servers-bundle-status-javaDebug");
  });
});
