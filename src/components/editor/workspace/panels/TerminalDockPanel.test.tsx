import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { TerminalDockPanel, type TerminalDockHandle } from "./TerminalDockPanel";

const registryMocks = vi.hoisted(() => ({
  getTerminal: vi.fn(),
}));

vi.mock("../../../../lib/terminal/terminalRegistry", () => registryMocks);
vi.mock("../../../../lib/runtime", () => ({ getAppPlatform: () => "linux" }));

vi.mock("../../../terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    tabId,
    initialCwd,
    workspaceRoot,
    onSessionReady,
    onTaskExit,
  }: {
    tabId?: string;
    initialCwd?: string;
    workspaceRoot?: string;
    onSessionReady?: (sessionId: string) => void;
    onTaskExit?: (exitCode: number) => void;
  }) => (
    <div
      data-testid="mock-terminal"
      data-tab-id={tabId}
      data-initial-cwd={initialCwd}
      data-workspace-root={workspaceRoot}
    >
      <button type="button" onClick={() => onSessionReady?.(tabId ?? "")}>ready</button>
      <button type="button" onClick={() => onTaskExit?.(0)}>task-exit</button>
    </div>
  ),
}));

afterEach(cleanup);

const roots = [
  { id: "app", name: "app", path: "/repo/app", kind: "git" as const },
  { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" as const },
];

describe("TerminalDockPanel", () => {
  it("starts lazily in the workspace cwd and supports multiple root terminals", async () => {
    const { rerender } = render(
      <TerminalDockPanel
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    expect(screen.queryByTestId("mock-terminal")).not.toBeInTheDocument();

    rerender(
      <TerminalDockPanel
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active
      />,
    );
    expect(await screen.findByTestId("mock-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");
    expect(screen.getByTestId("mock-terminal")).toHaveAttribute("data-workspace-root", "/repo/app");

    fireEvent.change(screen.getByLabelText("Terminal root directory"), { target: { value: "lib" } });
    fireEvent.click(screen.getByLabelText("New workspace terminal"));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    expect(screen.getAllByTestId("mock-terminal")[1]).toHaveAttribute("data-initial-cwd", "/repo/lib");
    expect(screen.getAllByTestId("mock-terminal")[1]).toHaveAttribute("data-workspace-root", "/repo/lib");
  });

  it("exposes open-at and closes instances by tab", async () => {
    const handle = createRef<TerminalDockHandle>();
    render(
      <TerminalDockPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    handle.current?.openAt("/repo/app/src", "src");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByTestId("mock-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app/src");
    expect(screen.getByTestId("mock-terminal")).toHaveAttribute("data-workspace-root", "/repo/app");
    fireEvent.click(screen.getByLabelText("Close src"));
    expect(screen.queryByTestId("mock-terminal")).not.toBeInTheDocument();
  });

  it("wraps task commands with an exit marker and reports completion", async () => {
    const writeInput = vi.fn();
    registryMocks.getTerminal.mockReturnValue({ writeInput });
    const handle = createRef<TerminalDockHandle>();
    const onExit = vi.fn();
    render(
      <TerminalDockPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    handle.current?.runCommand("pnpm test", "/repo/app", "test", onExit);
    fireEvent.click(await screen.findByRole("button", { name: "ready" }));
    await waitFor(() => expect(writeInput).toHaveBeenCalledWith(expect.stringContaining("TaomniTaskExit")));
    expect(writeInput).toHaveBeenCalledWith(expect.stringContaining("pnpm test"));
    fireEvent.click(screen.getByRole("button", { name: "task-exit" }));
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("forwards task-scoped environment values to registered terminals", async () => {
    const runTask = vi.fn();
    registryMocks.getTerminal.mockReturnValue({ runTask });
    const handle = createRef<TerminalDockHandle>();
    render(
      <TerminalDockPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    const environment = {
      MAVEN_OPTS: {
        value: "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
        mode: "append" as const,
      },
    };
    handle.current?.runCommand("./mvnw exec:java", "/repo/app", "run", undefined, environment);
    fireEvent.click(await screen.findByRole("button", { name: "ready" }));
    await waitFor(() => expect(runTask).toHaveBeenCalledWith("./mvnw exec:java", environment));
  });
});
