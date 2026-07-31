import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbConnectInfo } from "../../types";
import RedisClientTab from "./RedisClientTab";

const ipc = vi.hoisted(() => ({
  dbConnect: vi.fn(async () => undefined),
  dbDisconnect: vi.fn(async () => undefined),
  dbListSavedQueries: vi.fn(async () => []),
}));

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  const Panel = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Separator = () => <div />;
  return { Group, Panel, Separator, PanelGroup: Group, PanelResizeHandle: Separator };
});

vi.mock("../../lib/ipc", () => ({
  dbConnect: ipc.dbConnect,
  dbDisconnect: ipc.dbDisconnect,
  dbListSavedQueries: ipc.dbListSavedQueries,
  dbSaveSavedQuery: vi.fn(),
  dbArchiveSavedQuery: vi.fn(),
  dbDeleteSavedQuery: vi.fn(),
  redisDelKey: vi.fn(),
  redisExec: vi.fn(),
}));

vi.mock("./RedisKeyBrowser", () => ({
  RedisKeyBrowser: () => <div data-testid="redis-key-browser" />,
}));

vi.mock("./RedisValuePanel", () => ({
  RedisValuePanel: () => <div data-testid="redis-value-panel" />,
}));

vi.mock("./RedisNewKeyDialog", () => ({
  RedisNewKeyDialog: () => null,
}));

vi.mock("./RedisCli", () => ({
  RedisCli: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ runCommand: vi.fn() }));
    return <div data-testid="redis-cli" />;
  }),
}));

const info: DbConnectInfo = {
  sessionId: "redis-session",
  workspaceSessionId: "saved-redis-session",
  engine: "Redis",
  host: "127.0.0.1",
  port: 6379,
  username: "",
  password: "",
  database: "",
  ssl: false,
  dbIndex: 3,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RedisClientTab query library", () => {
  it("loads Redis commands with the stable saved-session and DB-index scope", async () => {
    render(<RedisClientTab tabId="redis-tab" info={info} visible />);
    await waitFor(() => expect(ipc.dbConnect).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Queries" }));

    await waitFor(() =>
      expect(ipc.dbListSavedQueries).toHaveBeenCalledWith({
        connectionId: "saved-redis-session",
        engine: "Redis",
        catalogName: undefined,
        databaseName: "3",
        schemaName: undefined,
        includeAllNamespaces: false,
        includeArchived: false,
      }),
    );
  });
});
