import { StrictMode, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DbClientTab from "./DbClientTab";
import type { DbConnectInfo } from "../../types";
import type { DbQueryWorkspace, DbSavedQuery } from "../../lib/ipc";
import { getQueryTab } from "../../lib/queryRegistry";

const ipcMock = vi.hoisted(() => ({
  dbConnect: vi.fn(),
  dbDisconnect: vi.fn(async () => undefined),
  dbExecute: vi.fn(async () => ({ columns: [], rows: [], rowsAffected: 0, durationMs: 1, warnings: [] })),
  dbRewriteResultSql: vi.fn(async (request: { sourceSql: string }) => ({
    sql: request.sourceSql,
    mode: "inline",
    reason: null,
    warnings: [],
  })),
  dbExecuteStream: vi.fn(async (
    _sessionId: string,
    _sql: string,
    _maxRows: number | null,
    onEvent: (event: { kind: "columns" | "rows" | "done"; columns?: unknown[]; rows?: unknown[][]; rowsAffected?: number; durationMs?: number; warnings?: string[] }) => void,
  ) => {
    onEvent({ kind: "columns", columns: [{ name: "one", type: "int4" }] });
    onEvent({ kind: "rows", rows: [["1"]] });
    onEvent({ kind: "done", rowsAffected: 0, durationMs: 1, warnings: [] });
  }),
  dbCancel: vi.fn(async () => undefined),
  dbAppendHistory: vi.fn(async () => undefined),
  dbListHistory: vi.fn(async () => []),
  dbDeleteHistory: vi.fn(async () => undefined),
  dbClearHistory: vi.fn(async () => undefined),
  dbLoadQueryWorkspace: vi.fn(async (): Promise<DbQueryWorkspace | null> => null),
  dbSaveQueryWorkspace: vi.fn(async () => undefined),
  dbGetSavedQuery: vi.fn(async (): Promise<DbSavedQuery | null> => null),
  dbSaveSavedQuery: vi.fn(),
  dbCloseQueryWorkspaceTabs: vi.fn(async () => undefined),
  dbListCatalogs: vi.fn(async () => []),
  dbListSchemas: vi.fn(async () => [{ name: "cdp" }]),
  dbListTables: vi.fn(async () => []),
  dbSearchTables: vi.fn(async () => []),
  dbListForeignKeys: vi.fn(async () => []),
  dbDescribeTable: vi.fn(async () => []),
}));

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="panel-group">{children}</div>
  );
  const Panel = forwardRef<unknown, { children: React.ReactNode; panelRef?: React.Ref<unknown> }>(({ children, panelRef }, ref) => {
    const handle = {
      resize: vi.fn(),
    };
    useImperativeHandle(ref, () => handle);
    useImperativeHandle(panelRef, () => handle);
    return <div data-testid="panel">{children}</div>;
  });
  const Separator = () => <div data-testid="panel-resize-handle" />;
  return {
    Group,
    Panel,
    Separator,
    PanelGroup: Group,
    PanelResizeHandle: Separator,
  };
});

vi.mock("../../lib/ipc", () => ({
  checkFileExists: vi.fn(async () => false),
  dbConnect: ipcMock.dbConnect,
  dbDisconnect: ipcMock.dbDisconnect,
  dbExecute: ipcMock.dbExecute,
  dbRewriteResultSql: ipcMock.dbRewriteResultSql,
  dbExecuteStream: ipcMock.dbExecuteStream,
  dbCancel: ipcMock.dbCancel,
  dbAppendHistory: ipcMock.dbAppendHistory,
  dbListHistory: ipcMock.dbListHistory,
  dbDeleteHistory: ipcMock.dbDeleteHistory,
  dbClearHistory: ipcMock.dbClearHistory,
  dbLoadQueryWorkspace: ipcMock.dbLoadQueryWorkspace,
  dbSaveQueryWorkspace: ipcMock.dbSaveQueryWorkspace,
  dbGetSavedQuery: ipcMock.dbGetSavedQuery,
  dbSaveSavedQuery: ipcMock.dbSaveSavedQuery,
  dbCloseQueryWorkspaceTabs: ipcMock.dbCloseQueryWorkspaceTabs,
  dbListCatalogs: ipcMock.dbListCatalogs,
  dbListSchemas: ipcMock.dbListSchemas,
  dbListTables: ipcMock.dbListTables,
  dbSearchTables: ipcMock.dbSearchTables,
  dbListForeignKeys: ipcMock.dbListForeignKeys,
  dbDescribeTable: ipcMock.dbDescribeTable,
  dbListBookmarks: vi.fn(async () => []),
  dbSaveBookmark: vi.fn(async () => undefined),
  dbDeleteBookmark: vi.fn(async () => undefined),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  selectSaveFilePath: vi.fn(async () => null),
  temporaryFilePath: vi.fn(async (name: string) => `/tmp/${name}`),
  writeStreamAbort: vi.fn(async () => undefined),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamOpen: vi.fn(async () => "stream-1"),
}));

const dbChildProps = vi.hoisted(() => ({
  schemaTree: null as null | { metadataCache?: unknown },
  sqlEditor: null as null | {
    metadataCache?: unknown;
    onDocChange?: (doc: string) => void;
    initialDoc?: string;
    setValue?: (doc: string) => void;
  },
  editorInitialDocFallback: "select 1",
  generatedSql: "select 1\nORDER BY \"one\" DESC;",
  generatedRequest: null as null | {
    engine: string;
    sourceSql: string;
    resultColumns: string[];
    visibleColumnIndexes: number[];
    globalFilterText: string;
    filters: unknown[];
    sorts: Array<{ columnIndex: number; dir: "asc" | "desc" }>;
  },
}));

vi.mock("./SchemaTree", () => ({
  SchemaTree: (props: { sessionId: string; metadataCache?: unknown }) => {
    dbChildProps.schemaTree = props;
    return <div data-testid="schema-tree" data-session-id={props.sessionId} />;
  },
}));

vi.mock("./SqlEditorPanel", () => ({
  SqlEditorPanel: ({
    handleRef,
    onRun,
    onDocChange,
    metadataCache,
    initialDoc,
  }: {
    handleRef: (handle: unknown | null) => void;
    onRun: (sql: string) => void;
    onDocChange?: (doc: string) => void;
    metadataCache?: unknown;
    initialDoc?: string;
  }) => {
    useEffect(() => {
      let doc = initialDoc || dbChildProps.editorInitialDocFallback;
      const handle = {
        getValue: () => doc,
        getSelectionOrAll: () => "select 1",
        getCursorPosition: () => doc.length,
        getSelectionRange: () => null,
        insertText: vi.fn(),
        setValue: vi.fn((text: string) => {
          doc = text;
        }),
        selectRange: vi.fn(),
        replaceRange: vi.fn((from: number, to: number, text: string) => {
          doc = `${doc.slice(0, from)}${text}${doc.slice(to)}`;
        }),
        focus: vi.fn(),
      };
      dbChildProps.sqlEditor = { metadataCache, onDocChange, initialDoc, setValue: handle.setValue };
      handleRef(handle);
      return () => handleRef(null);
    }, [handleRef, initialDoc]);
    return (
      <button type="button" data-testid="mock-sql-editor" onClick={() => onRun("select 1")}>
        editor
      </button>
    );
  },
}));

vi.mock("./QueryResultGrid", () => ({
  QueryResultGrid: ({
    onGeneratedSqlSync,
    onGeneratedSqlQuery,
  }: {
    onGeneratedSqlSync?: (sql: string, mode: "sync" | "replaceSource") => void;
    onGeneratedSqlQuery?: (sql: string, request?: typeof dbChildProps.generatedRequest) => void;
  }) => {
    return (
      <div data-testid="query-result-grid">
        <button type="button" data-testid="sync-generated-sql" onClick={() => onGeneratedSqlSync?.(dbChildProps.generatedSql, "sync")}>
          sync generated
        </button>
        <button type="button" data-testid="query-generated-sql" onClick={() => onGeneratedSqlQuery?.(dbChildProps.generatedSql, dbChildProps.generatedRequest ?? undefined)}>
          query generated
        </button>
      </div>
    );
  },
}));

vi.mock("../tabbar/TabActionSlot", () => ({
  TabActions: ({ active, children }: { active: boolean; children: React.ReactNode }) =>
    active ? <div data-testid="tab-action-slot">{children}</div> : null,
}));

const contextMenuShow = vi.hoisted(() => vi.fn());

vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({ show: contextMenuShow, render: null, showAt: vi.fn(), refreshItems: vi.fn(), close: vi.fn(), isOpen: false }),
}));

vi.mock("../../lib/capture", () => ({
  captureElementPng: vi.fn(async () => new Uint8Array()),
  renderElementToCanvas: vi.fn(async () => null),
  safeFilePart: (value: string) => value,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const postgresInfo: DbConnectInfo = {
  sessionId: "saved-pg",
  workspaceSessionId: "saved-pg",
  engine: "PostgreSQL",
  host: "hgpost.example.test",
  port: 80,
  username: "ak",
  password: "sk",
  database: "cdp",
  ssl: false,
};

const panweiInfo: DbConnectInfo = {
  sessionId: "saved-panwei",
  workspaceSessionId: "saved-panwei",
  engine: "PanWeiDB",
  host: "192.168.152.250",
  port: 17700,
  username: "panwei_omm",
  password: "secret",
  database: "panweidb",
  ssl: false,
};

describe("DbClientTab connection lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.schemaTree = null;
    dbChildProps.sqlEditor = null;
    dbChildProps.editorInitialDocFallback = "select 1";
    dbChildProps.generatedSql = "select 1\nORDER BY \"one\" DESC;";
    dbChildProps.generatedRequest = null;
    contextMenuShow.mockClear();
  });

  it("keeps queries on the latest runtime connection when a stale StrictMode connect resolves late", async () => {
    const firstConnect = deferred<{ ok: boolean }>();
    const secondConnect = deferred<{ ok: boolean }>();
    ipcMock.dbConnect
      .mockImplementationOnce(() => firstConnect.promise)
      .mockImplementationOnce(() => secondConnect.promise);

    render(
      <StrictMode>
        <DbClientTab tabId="tab-1" info={postgresInfo} visible />
      </StrictMode>,
    );

    await waitFor(() => expect(ipcMock.dbConnect).toHaveBeenCalledTimes(2));
    const connectCalls = ipcMock.dbConnect.mock.calls as Array<[DbConnectInfo]>;
    const firstRuntimeId = connectCalls[0][0].sessionId;
    const secondRuntimeId = connectCalls[1][0].sessionId;
    expect(firstRuntimeId).toMatch(/^saved-pg::/);
    expect(secondRuntimeId).toMatch(/^saved-pg::/);
    expect(secondRuntimeId).not.toBe(firstRuntimeId);

    await act(async () => {
      secondConnect.resolve({ ok: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("schema-tree")).toHaveAttribute("data-session-id", secondRuntimeId);
    });

    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledWith(
        secondRuntimeId,
        "select 1",
        1000,
        expect.any(Function),
      );
    });

    await act(async () => {
      firstConnect.resolve({ ok: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      const disconnectCalls = ipcMock.dbDisconnect.mock.calls as unknown as Array<[string]>;
      const oldDisconnects = disconnectCalls.filter(([id]) => id === firstRuntimeId);
      expect(oldDisconnects.length).toBeGreaterThanOrEqual(2);
    });
    const disconnectCalls = ipcMock.dbDisconnect.mock.calls as unknown as Array<[string]>;
    expect(disconnectCalls.some(([id]) => id === secondRuntimeId)).toBe(false);
  });

  it("shares one metadata cache between schema tree and SQL editor", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => {
      expect(screen.getByTestId("schema-tree")).toBeInTheDocument();
      expect(dbChildProps.schemaTree?.metadataCache).toBeTruthy();
      expect(dbChildProps.sqlEditor?.metadataCache).toBe(dbChildProps.schemaTree?.metadataCache);
    });
  });

  it("keeps query drafts and the library available when the connection fails", async () => {
    ipcMock.dbConnect.mockRejectedValueOnce(new Error("database offline"));

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    expect(await screen.findByTestId("db-connection-error-banner")).toHaveTextContent("database offline");
    fireEvent.click(screen.getByRole("button", { name: "Queries" }));
    expect(screen.getByTestId("query-library-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-sql-editor")).toBeInTheDocument();
  });

  it("restores SQL editor content from the SQLite query workspace", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "restored-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "restored-panel",
        tabOrder: 0,
        content: "select restored_from_sqlite",
        filePath: null,
        fileName: null,
        dirty: true,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => {
      expect(dbChildProps.sqlEditor?.initialDoc).toBe("select restored_from_sqlite");
    });
  });

  it("flushes the latest editor buffer through the query registry", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(getQueryTab("tab-1")?.flushWorkspace).toBeTypeOf("function"));

    act(() => {
      getQueryTab("tab-1")?.insertQuery("select persisted_buffer", { position: "replaceAll" });
    });
    await act(async () => {
      await getQueryTab("tab-1")?.flushWorkspace?.();
    });

    expect(ipcMock.dbSaveQueryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "saved-pg",
      activePanelId: expect.any(String),
      tabs: [expect.objectContaining({ content: "select persisted_buffer" })],
    }));
  });

  it("restores a saved-query link and flushes edits to both repositories", async () => {
    const savedQuery: DbSavedQuery = {
      id: "saved-query-1",
      scopeType: "connection",
      scopeId: "saved-pg",
      engine: "PostgreSQL",
      catalogName: null,
      databaseName: "cdp",
      schemaName: "public",
      namespaceKey: "namespace",
      name: "Linked query",
      content: "select original",
      remarks: null,
      tags: [],
      revision: 1,
      archivedAt: null,
      createdAt: 100,
      updatedAt: 100,
    };
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbGetSavedQuery.mockResolvedValueOnce(savedQuery);
    ipcMock.dbSaveSavedQuery.mockImplementation(async (query: DbSavedQuery) => ({
      ...query,
      revision: query.revision + 1,
    }));
    ipcMock.dbLoadQueryWorkspace.mockResolvedValueOnce({
      workspaceId: "saved-pg",
      activePanelId: "linked-panel",
      updatedAt: 200,
      tabs: [{
        workspaceId: "saved-pg",
        panelId: "linked-panel",
        tabOrder: 0,
        content: "select original",
        filePath: null,
        fileName: null,
        savedQueryId: "saved-query-1",
        dirty: false,
        isOpen: true,
        closedAt: null,
        createdAt: 100,
        updatedAt: 200,
      }],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(dbChildProps.sqlEditor?.initialDoc).toBe("select original"));

    act(() => {
      dbChildProps.sqlEditor?.setValue?.("select changed");
      dbChildProps.sqlEditor?.onDocChange?.("select changed");
    });
    await act(async () => {
      await getQueryTab("tab-1")?.flushWorkspace?.();
    });

    expect(ipcMock.dbSaveSavedQuery).toHaveBeenCalledWith(expect.objectContaining({
      id: "saved-query-1",
      revision: 1,
      content: "select changed",
    }));
    expect(ipcMock.dbSaveQueryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      tabs: [expect.objectContaining({
        savedQueryId: "saved-query-1",
        content: "select changed",
        dirty: false,
      })],
    }));
  });

  it("does not rewrite workspace metadata for document-only changes", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
    await waitFor(() => expect(dbChildProps.sqlEditor?.onDocChange).toBeTypeOf("function"));
    setItem.mockClear();

    act(() => dbChildProps.sqlEditor?.onDocChange?.("select 2"));

    expect(
      setItem.mock.calls.some(([key]) => String(key).startsWith("taomni.db.queryWorkspace.v1.")),
    ).toBe(false);
  });

  it("uses PanWeiDB schema metadata instead of treating the connection database as the schema", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    ipcMock.dbListSchemas.mockResolvedValueOnce([{ name: "panwei_omm" }, { name: "public" }]);

    render(<DbClientTab tabId="tab-panwei" info={panweiInfo} visible />);

    const schemaSelect = await screen.findByLabelText("Schema");
    await waitFor(() => expect(schemaSelect).toHaveValue("panwei_omm"));
    expect(ipcMock.dbListSchemas).toHaveBeenCalledWith(
      expect.stringMatching(/^saved-panwei::/),
      null,
    );
    expect(ipcMock.dbListTables).not.toHaveBeenCalled();
  });

  it("appends echoed agent SQL with comments and semicolons into one query panel", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    expect(getQueryTab("tab-1")).toBeTruthy();
    const entry = getQueryTab("tab-1");
    expect(entry).toBeTruthy();

    act(() => {
      entry?.appendEchoSql("select * from foo", "-- Claude Code ok");
      entry?.appendEchoSql("select * from bar;\n", "-- Claude Code captured");
    });

    await waitFor(() => {
      const editorButton = screen.getByTestId("mock-sql-editor");
      expect(editorButton).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("Run (F5)"));

    // PostgreSQL scripts are split client-side so each statement is prepared alone (#403).
    await waitFor(() => {
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2);
      expect(ipcMock.dbExecuteStream).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/^saved-pg::/),
        "-- Claude Code ok\nselect * from foo",
        1000,
        expect.any(Function),
      );
      expect(ipcMock.dbExecuteStream).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/^saved-pg::/),
        "-- Claude Code captured\nselect * from bar",
        1000,
        expect.any(Function),
      );
    });
    expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2);
  });

  it("shows the execution start time on result sheets", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 6, 2, 11, 12, 13).getTime());

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      expect(screen.getByText("11:12:13")).toBeInTheDocument();
      expect(screen.getAllByTitle(/Started: 2026-07-02 11:12:13/).length).toBeGreaterThan(0);
    });
  });

  it("supports batch close actions from the result sheet context menu", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());

    // Open three result sheets (one Run per statement for a stable tab order).
    for (let count = 1; count <= 3; count += 1) {
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(count);
      });
    }

    type MenuItem = {
      label: string;
      testId?: string;
      disabled?: boolean;
      onClick?: () => void;
    };
    const lastSheetMenu = (): MenuItem[] => {
      const menuCalls = contextMenuShow.mock.calls as Array<[unknown, MenuItem[]]>;
      const sheetMenuCall = [...menuCalls].reverse().find(([, items]) =>
        items.some((item) => item.testId === "result-sheet-close-others"),
      );
      expect(sheetMenuCall).toBeTruthy();
      return sheetMenuCall![1];
    };

    const sheets = screen.getAllByTestId("result-sheet-tab");
    fireEvent.contextMenu(sheets[1]);
    const items = lastSheetMenu();
    expect(items.find((item) => item.testId === "result-sheet-close-left")?.disabled).toBe(false);
    expect(items.find((item) => item.testId === "result-sheet-close-right")?.disabled).toBe(false);
    expect(items.find((item) => item.testId === "result-sheet-close-others")?.disabled).toBe(false);

    act(() => {
      items.find((item) => item.testId === "result-sheet-close-others")?.onClick?.();
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(1);
      expect(screen.getByText("Result 2")).toBeInTheDocument();
    });

    // Rebuild more sheets and verify close left / right / all.
    for (let count = 2; count <= 4; count += 1) {
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => {
        expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(count);
      });
    }

    fireEvent.contextMenu(screen.getAllByTestId("result-sheet-tab")[1]);
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-left")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(3);
    });

    fireEvent.contextMenu(screen.getAllByTestId("result-sheet-tab")[0]);
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-right")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(1);
    });

    fireEvent.contextMenu(screen.getByTestId("result-sheet-tab"));
    act(() => {
      lastSheetMenu().find((item) => item.testId === "result-sheet-close-all")?.onClick?.();
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId("result-sheet-tab")).toHaveLength(0);
    });
  });

  it("creates one generated SQL query panel only after manual sync", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => expect(screen.getByTestId("query-result-grid")).toBeInTheDocument());
    expect(screen.queryAllByTitle("Generated SQL")).toHaveLength(0);
    expect(screen.getByTestId("query-result-grid")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-generated-sql"));

    await waitFor(() => expect(screen.getAllByTitle("Generated SQL")).toHaveLength(1));
  });

  it("queries generated SQL by replacing the source statement and refreshing the current sheet", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;";
    dbChildProps.generatedRequest = {
      engine: "PostgreSQL",
      sourceSql: "select 1",
      resultColumns: ["one"],
      visibleColumnIndexes: [0],
      globalFilterText: "",
      filters: [],
      sorts: [{ columnIndex: 0, dir: "desc" }],
    };
    ipcMock.dbRewriteResultSql.mockResolvedValueOnce({
      sql: dbChildProps.generatedSql,
      mode: "inline",
      reason: null,
      warnings: [],
    });

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Run (F5)"));
    await waitFor(() => expect(screen.getByTestId("query-result-grid")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("query-generated-sql"));

    await waitFor(() => {
      expect(ipcMock.dbRewriteResultSql).toHaveBeenCalledWith(dbChildProps.generatedRequest);
    });
    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toContain("ORDER BY \"one\" DESC");
      expect(calls.at(-1)?.[1]).not.toContain(";;");
    });

    fireEvent.click(screen.getByTitle("Run (F5)"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toContain("ORDER BY \"one\" DESC");
      expect(calls.at(-1)?.[1]).not.toContain(";;");
    });
  });

  it("runs the current editor statement at the cursor", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Current statement actions"));
    await waitFor(() => expect(screen.getByTestId("db-current-statement-panel")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("db-current-statement-run"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toBe("select 2");
    });
  });

  it("runs the current statement from the Current toolbar button", async () => {
    ipcMock.dbConnect.mockResolvedValue({ ok: true });
    dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";

    render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);

    await waitFor(() => expect(screen.getByTestId("schema-tree")).toBeInTheDocument());
    expect(screen.getByTestId("db-run-current-statement")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("db-run-current-statement"));

    await waitFor(() => {
      const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
      expect(calls.at(-1)?.[1]).toBe("select 2");
    });
  });
});

