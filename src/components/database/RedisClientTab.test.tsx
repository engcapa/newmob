import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbConnectInfo } from "../../types";
import type { AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import RedisClientTab from "./RedisClientTab";

const ipc = vi.hoisted(() => ({
  dbConnect: vi.fn(async () => undefined),
  dbDisconnect: vi.fn(async () => undefined),
  dbListSavedQueries: vi.fn(async () => []),
}));

const chat = vi.hoisted(() => ({
  openTabChat: vi.fn(async (_tabId: string) => undefined),
  sendPromptToTabChat: vi.fn(async (_prompt: string) => ({ status: "sent" as const })),
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

vi.mock("../../stores/chatStore", () => ({
  useChatStore: {
    getState: () => chat,
  },
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

interface MockRedisCliProps {
  answerLanguage?: AiAnswerLanguage;
  onSetAnswerLanguage?: (language: AiAnswerLanguage) => void;
  onExplain?: (command: string, reply?: string) => void;
}

vi.mock("./RedisCli", () => ({
  RedisCli: forwardRef((props: MockRedisCliProps, ref) => {
    useImperativeHandle(ref, () => ({ runCommand: vi.fn() }));
    return (
      <div data-testid="redis-cli" data-answer-language={props.answerLanguage}>
        <button
          type="button"
          data-testid="mock-redis-language-zh"
          onClick={() => props.onSetAnswerLanguage?.("zh-CN")}
        >
          中文
        </button>
        <button
          type="button"
          data-testid="mock-redis-explain"
          onClick={() => props.onExplain?.("PING", "PONG")}
        >
          Explain
        </button>
      </div>
    );
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

  it("keeps the query library available after a Redis connection failure", async () => {
    ipc.dbConnect.mockRejectedValueOnce(new Error("redis offline"));
    render(<RedisClientTab tabId="redis-tab" info={info} visible />);

    expect(await screen.findByTestId("redis-connection-error-banner")).toHaveTextContent("redis offline");
    fireEvent.click(screen.getByRole("button", { name: "Queries" }));
    expect(screen.getByTestId("query-library-panel")).toBeInTheDocument();
  });

  it("uses the updated session answer language for explain prompts", async () => {
    render(<RedisClientTab tabId="redis-tab" info={info} visible />);
    await waitFor(() => expect(ipc.dbConnect).toHaveBeenCalled());

    expect(screen.getByTestId("redis-cli")).toHaveAttribute("data-answer-language", "inherit");
    fireEvent.click(screen.getByTestId("mock-redis-language-zh"));
    expect(screen.getByTestId("redis-cli")).toHaveAttribute("data-answer-language", "zh-CN");

    fireEvent.click(screen.getByTestId("mock-redis-explain"));

    await waitFor(() => expect(chat.sendPromptToTabChat).toHaveBeenCalledTimes(1));
    const prompt = chat.sendPromptToTabChat.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("## 上下文");
    expect(prompt).toContain("Redis 命令");
    expect(prompt).not.toContain("## Context");
  });
});
