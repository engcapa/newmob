import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
