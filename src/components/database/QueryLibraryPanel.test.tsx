import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryLibraryPanel } from "./QueryLibraryPanel";
import type { DbSavedQuery } from "../../lib/ipc";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  dbListSavedQueries: mocks.list,
  dbSaveSavedQuery: mocks.save,
  dbArchiveSavedQuery: mocks.archive,
  dbDeleteSavedQuery: mocks.remove,
}));

vi.mock("../../lib/appDialogs", () => ({
  confirmAppDialog: vi.fn(async () => true),
}));

vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({ show: vi.fn(), render: null }),
}));

function savedQuery(patch: Partial<DbSavedQuery> = {}): DbSavedQuery {
  return {
    id: "query-1",
    scopeType: "connection",
    scopeId: "session-1",
    engine: "PostgreSQL",
    catalogName: null,
    databaseName: "app",
    schemaName: "public",
    namespaceKey: "namespace",
    name: "Active users",
    content: "select * from users where active",
    remarks: "Used by support",
    tags: ["users"],
    revision: 1,
    archivedAt: null,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof QueryLibraryPanel>> = {}) {
  const props: React.ComponentProps<typeof QueryLibraryPanel> = {
    engine: "PostgreSQL",
    connectionId: "session-1",
    activeContent: "select 42",
    databaseName: "app",
    schemaName: "public",
    onOpenQuery: vi.fn(),
    onRunQuery: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<QueryLibraryPanel {...props} />) };
}

describe("QueryLibraryPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.list.mockReset();
    mocks.save.mockReset();
    mocks.archive.mockReset();
    mocks.remove.mockReset();
    mocks.list.mockResolvedValue([]);
  });

  it("loads connection and engine queries for the current namespace", async () => {
    mocks.list.mockResolvedValue([savedQuery()]);
    renderPanel();

    expect(await screen.findByText("Active users")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({
      connectionId: "session-1",
      engine: "PostgreSQL",
      catalogName: undefined,
      databaseName: "app",
      schemaName: "public",
      includeAllNamespaces: false,
      includeArchived: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeAllNamespaces: true }),
      ),
    );
  });

  it("creates a connection-scoped Query-N from the active editor", async () => {
    const saved = savedQuery({ name: "Query-1", content: "select 42" });
    mocks.save.mockResolvedValue(saved);
    const onSavedQuery = vi.fn();
    renderPanel({ onSavedQuery });

    fireEvent.click(screen.getByRole("button", { name: "Save current editor as query" }));
    expect(screen.getByRole("textbox", { name: "SQL content" })).toHaveValue("select 42");
    fireEvent.change(screen.getByRole("textbox", { name: "Query name" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Query" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeType: "connection",
        scopeId: "session-1",
        engine: "PostgreSQL",
        name: "",
        content: "select 42",
        databaseName: "app",
        schemaName: "public",
      }),
    );
    expect(onSavedQuery).toHaveBeenCalledWith(saved, true);
  });

  it("opens on click and runs on double click", async () => {
    const query = savedQuery();
    mocks.list.mockResolvedValue([query]);
    const onOpenQuery = vi.fn();
    const onRunQuery = vi.fn();
    renderPanel({ onOpenQuery, onRunQuery });

    const item = await screen.findByTestId("saved-query-query-1");
    fireEvent.click(item);
    fireEvent.doubleClick(item);

    expect(onOpenQuery).toHaveBeenCalledWith(query);
    expect(onRunQuery).toHaveBeenCalledWith(query);
  });

  it("can save an engine-scoped command for non-SQL database sessions", async () => {
    mocks.save.mockImplementation(async (query: DbSavedQuery) => ({ ...query, name: "Query-1", revision: 1 }));
    renderPanel({
      engine: "Redis",
      connectionId: "redis-1",
      databaseName: "0",
      contentLabel: "Redis command",
      activeContent: "SCAN 0",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save current editor as query" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Query scope" }), {
      target: { value: "engine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Query" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeType: "engine",
          scopeId: "Redis",
          engine: "Redis",
          databaseName: "0",
          content: "SCAN 0",
        }),
      ),
    );
  });
});
