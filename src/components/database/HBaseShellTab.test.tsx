import { forwardRef, useEffect, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HBaseShellTab from "./HBaseShellTab";
import type { HBaseConnectInfo } from "../../types";

const editorState = vi.hoisted(() => ({ value: "list" }));

const ipcMock = vi.hoisted(() => ({
  hbaseConnect: vi.fn(async () => ({ ok: true })),
  hbaseDisconnect: vi.fn(async () => undefined),
  hbaseCancel: vi.fn(async () => undefined),
  hbaseExecute: vi.fn(async (_s: string, command: string) => ({
    command,
    message: "1 row(s)",
    columns: ["ROW", "VALUE"],
    rows: [["r1", "v1"]],
    warnings: [],
    durationMs: 5,
  })),
  dbListSavedQueries: vi.fn(async () => []),
  dbSaveSavedQuery: vi.fn(),
  dbArchiveSavedQuery: vi.fn(),
  dbDeleteSavedQuery: vi.fn(),
}));

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  const Panel = forwardRef<unknown, { children: React.ReactNode; panelRef?: React.Ref<unknown> }>(
    ({ children, panelRef }, ref) => {
      const handle = { resize: vi.fn() };
      useImperativeHandle(ref, () => handle);
      useImperativeHandle(panelRef, () => handle);
      return <div>{children}</div>;
    },
  );
  const Separator = () => <div />;
  return { Group, Panel, Separator, PanelGroup: Group, PanelResizeHandle: Separator };
});

vi.mock("../../lib/ipc", () => ({
  hbaseConnect: ipcMock.hbaseConnect,
  hbaseDisconnect: ipcMock.hbaseDisconnect,
  hbaseCancel: ipcMock.hbaseCancel,
  hbaseExecute: ipcMock.hbaseExecute,
  dbListSavedQueries: ipcMock.dbListSavedQueries,
  dbSaveSavedQuery: ipcMock.dbSaveSavedQuery,
  dbArchiveSavedQuery: ipcMock.dbArchiveSavedQuery,
  dbDeleteSavedQuery: ipcMock.dbDeleteSavedQuery,
}));

vi.mock("./HBaseSchemaTree", () => ({
  HBaseSchemaTree: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="hbase-schema-tree" data-session-id={sessionId ?? ""} />
  ),
}));

vi.mock("./SqlEditorPanel", () => ({
  SqlEditorPanel: ({
    handleRef,
    onRun,
  }: {
    handleRef: (handle: unknown | null) => void;
    onRun: (sql: string) => void;
  }) => {
    useEffect(() => {
      handleRef({
        getValue: () => editorState.value,
        getSelectionOrAll: () => editorState.value,
        insertText: vi.fn(),
        setValue: vi.fn(),
        focus: vi.fn(),
      });
      return () => handleRef(null);
    }, [handleRef]);
    return (
      <button type="button" data-testid="mock-editor" onClick={() => onRun(editorState.value)}>
        editor
      </button>
    );
  },
}));

vi.mock("./QueryResultGrid", () => ({
  QueryResultGrid: ({ result }: { result: { rows: unknown[] } }) => (
    <div data-testid="query-result-grid">{result.rows.length} rows</div>
  ),
}));

const info: HBaseConnectInfo = {
  sessionId: "hb1",
  host: "localhost",
  port: 8080,
  connectionMode: "rest",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  editorState.value = "list";
  localStorage.clear();
});

describe("HBaseShellTab workspace", () => {
  it("connects and renders the editor toolbar", async () => {
    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    expect(await screen.findByText("Run")).toBeInTheDocument();
    expect(screen.getByTestId("hbase-schema-tree")).toBeInTheDocument();
  });

  it("runs a read command and shows a result sheet", async () => {
    editorState.value = "list";
    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    // Wait for the connection session to settle, enabling the editor's run.
    fireEvent.click(await screen.findByTestId("mock-editor"));
    await waitFor(() => expect(ipcMock.hbaseExecute).toHaveBeenCalledWith(expect.any(String), "list"));
    expect(await screen.findByTestId("query-result-grid")).toHaveTextContent("1 rows");
  });

  it("uses the shared tab limit for query tabs and result tabs", async () => {
    localStorage.setItem("taomni.db.HBaseShell.tabLimit", "2");

    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    expect(screen.getByTestId("hbase-tab-limit")).toHaveValue(2);

    fireEvent.click(screen.getByTitle("New query panel"));
    await waitFor(() => expect(screen.getByTitle("Query 2")).toBeInTheDocument());
    expect(screen.queryByTitle("New query panel")).not.toBeInTheDocument();

    for (let run = 0; run < 3; run += 1) {
      fireEvent.click(screen.getByTestId("mock-editor"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(Math.min(run + 1, 2));
      });
    }
  });

  it("forces a confirmation popup before a write command and runs it on confirm", async () => {
    editorState.value = "drop 'users'";
    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("mock-editor"));
    // The forced confirmation dialog must appear before any execution.
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("drop 'users'");
    expect(ipcMock.hbaseExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(ipcMock.hbaseExecute).toHaveBeenCalledWith(expect.any(String), "drop 'users'"));
  });

  it("does not run a write command when the confirmation is cancelled", async () => {
    editorState.value = "deleteall 'users', 'r1'";
    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("mock-editor"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-cancel"));
    // Give any pending microtasks a chance, then assert nothing ran.
    await new Promise((r) => setTimeout(r, 0));
    expect(ipcMock.hbaseExecute).not.toHaveBeenCalled();
  });

  it("opens a command-reference help dialog and gates admin commands on REST", async () => {
    render(<HBaseShellTab tabId="t1" info={info} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Help"));
    const dialog = await screen.findByTestId("hbase-help-dialog");
    expect(dialog).toHaveTextContent("count");
    expect(dialog).toHaveTextContent("enable");
    // REST transport => admin verbs carry the unsupported note.
    expect(dialog).toHaveTextContent("Not available on the REST transport");
  });

  it("opens the shared query library with the stable HBase session scope", async () => {
    render(<HBaseShellTab tabId="t1" info={{ ...info, namespace: "prod" }} visible />);
    await waitFor(() => expect(ipcMock.hbaseConnect).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Queries" }));

    await waitFor(() =>
      expect(ipcMock.dbListSavedQueries).toHaveBeenCalledWith({
        connectionId: "hb1",
        engine: "HBaseShell",
        catalogName: undefined,
        databaseName: undefined,
        schemaName: "prod",
        includeAllNamespaces: false,
        includeArchived: false,
      }),
    );
  });
});
