import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { RedisCli, type RedisCliHandle } from "./RedisCli";

const redisExec = vi.hoisted(() => vi.fn());

vi.mock("../../lib/ipc", () => ({ redisExec }));

function Harness({ onSaveQuery = vi.fn() }: { onSaveQuery?: () => void }) {
  const [input, setInput] = useState("");
  return (
    <RedisCli
      sessionId="redis-runtime"
      collapsed={false}
      onToggleCollapse={vi.fn()}
      input={input}
      onInputChange={setInput}
      onSaveQuery={onSaveQuery}
    />
  );
}

describe("RedisCli query library bridge", () => {
  beforeEach(() => {
    redisExec.mockReset();
    redisExec.mockResolvedValue("PONG");
  });

  afterEach(cleanup);

  it("keeps the command draft controlled and exposes the save action", () => {
    const onSaveQuery = vi.fn();
    render(<Harness onSaveQuery={onSaveQuery} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Redis command" }), {
      target: { value: "SCAN 0" },
    });
    expect(screen.getByRole("textbox", { name: "Redis command" })).toHaveValue("SCAN 0");

    fireEvent.click(screen.getByRole("button", { name: "Save Query" }));
    expect(onSaveQuery).toHaveBeenCalledTimes(1);
  });

  it("runs a saved command through the CLI and keeps its output", async () => {
    const ref = createRef<RedisCliHandle>();
    render(
      <RedisCli
        ref={ref}
        sessionId="redis-runtime"
        collapsed={false}
        onToggleCollapse={vi.fn()}
        input=""
        onInputChange={vi.fn()}
        onSaveQuery={vi.fn()}
      />,
    );

    await act(async () => {
      await ref.current?.runCommand("PING");
    });

    expect(redisExec).toHaveBeenCalledWith("redis-runtime", "PING");
    expect(screen.getByText("> PING")).toBeInTheDocument();
    expect(screen.getByText("PONG")).toBeInTheDocument();
  });
});

describe("RedisCli explain action", () => {
  beforeEach(() => {
    redisExec.mockReset();
    redisExec.mockResolvedValue("PONG");
  });

  afterEach(cleanup);

  function renderCli(props: {
    input?: string;
    onExplain?: (command: string, reply?: string) => void;
    answerLanguage?: AiAnswerLanguage;
    onSetAnswerLanguage?: (language: AiAnswerLanguage) => void;
    ref?: React.Ref<RedisCliHandle>;
  } = {}) {
    return render(
      <RedisCli
        ref={props.ref}
        sessionId="redis-runtime"
        collapsed={false}
        onToggleCollapse={vi.fn()}
        input={props.input ?? ""}
        onInputChange={vi.fn()}
        onSaveQuery={vi.fn()}
        onExplain={props.onExplain}
        answerLanguage={props.answerLanguage}
        onSetAnswerLanguage={props.onSetAnswerLanguage}
      />,
    );
  }

  it("explains the drafted command", () => {
    const onExplain = vi.fn();
    renderCli({ input: "KEYS *", onExplain });

    fireEvent.click(screen.getByTestId("redis-explain-current"));

    expect(onExplain).toHaveBeenCalledWith("KEYS *");
  });

  it("disables explain with nothing to explain", () => {
    renderCli({ input: "   ", onExplain: vi.fn() });
    expect(screen.getByTestId("redis-explain-current")).toBeDisabled();
  });

  it("hides the explain affordances when the host wires no handler", () => {
    renderCli({ input: "KEYS *" });
    expect(screen.queryByTestId("redis-explain-current")).not.toBeInTheDocument();
  });

  it("explains an executed command together with its reply", async () => {
    const onExplain = vi.fn();
    const ref = createRef<RedisCliHandle>();
    renderCli({ onExplain, ref });

    await act(async () => {
      await ref.current?.runCommand("PING");
    });

    fireEvent.click(screen.getByTestId("redis-explain-line"));

    // The reply rides along so the answer can address what actually came back.
    expect(onExplain).toHaveBeenCalledWith("PING", "PONG");
  });

  it("uses the clicked output line for the context-menu explanation", async () => {
    const onExplain = vi.fn();
    const ref = createRef<RedisCliHandle>();
    renderCli({ input: "GET another-key", onExplain, ref });

    await act(async () => {
      await ref.current?.runCommand("PING");
    });

    fireEvent.contextMenu(screen.getByText("> PING"));
    fireEvent.click(screen.getByTestId("redis-context-ai-explain-syntax"));

    expect(onExplain).toHaveBeenCalledWith("PING", "PONG");
  });

  it("uses the current draft for the input context-menu explanation", () => {
    const onExplain = vi.fn();
    renderCli({ input: "KEYS *", onExplain });

    fireEvent.contextMenu(screen.getByRole("textbox", { name: "Redis command" }));
    fireEvent.click(screen.getByTestId("redis-context-ai-explain-syntax"));

    expect(onExplain).toHaveBeenCalledWith("KEYS *", undefined);
  });

  it("changes the session answer language from the toolbar", () => {
    const onSetAnswerLanguage = vi.fn();
    renderCli({
      answerLanguage: "inherit",
      onSetAnswerLanguage,
    });

    fireEvent.click(screen.getByTestId("redis-ai-answer-language-toggle"));
    fireEvent.click(screen.getByTestId("redis-ai-answer-language-option-zh-CN"));

    expect(onSetAnswerLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("changes the session answer language from the context menu", async () => {
    const onSetAnswerLanguage = vi.fn();
    renderCli({
      input: "PING",
      answerLanguage: "inherit",
      onSetAnswerLanguage,
    });

    fireEvent.contextMenu(screen.getByRole("textbox", { name: "Redis command" }));
    fireEvent.mouseEnter(screen.getByTestId("redis-context-ai-answer-language"));
    fireEvent.click(await screen.findByTestId("redis-context-ai-answer-language-en"));

    expect(onSetAnswerLanguage).toHaveBeenCalledWith("en");
  });

  it("passes the error text as the reply for a failed command", async () => {
    redisExec.mockRejectedValue(new Error("WRONGTYPE"));
    const onExplain = vi.fn();
    const ref = createRef<RedisCliHandle>();
    renderCli({ onExplain, ref });

    await act(async () => {
      await ref.current?.runCommand("LPUSH mykey v");
    });

    fireEvent.click(screen.getByTestId("redis-explain-line"));

    expect(onExplain).toHaveBeenCalledWith("LPUSH mykey v", expect.stringContaining("WRONGTYPE"));
  });
});
