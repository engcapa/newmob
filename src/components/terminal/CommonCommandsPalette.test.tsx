import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  historyListRecent: vi.fn(async (_hostKey: string, _limit: number) => [] as string[]),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

import {
  CommonCommandsPalette,
  __testing,
  type Candidate,
} from "./CommonCommandsPalette";
import type { PresetCommand } from "../../lib/commonCommandsPresets";

const presets: PresetCommand[] = [
  { command: "git status", description: "show status" },
  { command: "ipconfig /all", description: "network info" },
  { command: "Get-Date" },
];

describe("mergeCandidates", () => {
  it("orders history first, then user, then presets", () => {
    const merged = __testing.mergeCandidates(
      ["git pull"],
      [{ command: "my-cmd", description: "mine" }],
      presets,
    );
    const sources = merged.map((c) => c.source);
    expect(sources[0]).toBe("history");
    expect(sources[1]).toBe("user");
    expect(sources.slice(2).every((s) => s === "preset")).toBe(true);
  });

  it("dedupes by exact command string keeping the first occurrence", () => {
    const merged = __testing.mergeCandidates(
      ["git status"],
      [{ command: "git status", description: "user override" }],
      presets,
    );
    const matches = merged.filter((c) => c.command === "git status");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("history");
  });

  it("ignores empty entries", () => {
    const merged = __testing.mergeCandidates(["", "ls"], [{ command: "" }], []);
    expect(merged.map((c) => c.command)).toEqual(["ls"]);
  });
});

describe("filterCandidates", () => {
  const items: Candidate[] = [
    { command: "git status", description: "show status", source: "preset" },
    { command: "ipconfig /all", description: "network info", source: "preset" },
  ];

  it("returns all when query is empty", () => {
    expect(__testing.filterCandidates(items, "")).toHaveLength(2);
    expect(__testing.filterCandidates(items, "   ")).toHaveLength(2);
  });

  it("matches against command and description case-insensitively", () => {
    expect(__testing.filterCandidates(items, "STATUS")).toHaveLength(1);
    expect(__testing.filterCandidates(items, "network")).toHaveLength(1);
    expect(__testing.filterCandidates(items, "nope")).toHaveLength(0);
  });
});

describe("CommonCommandsPalette", () => {
  beforeEach(() => {
    ipcMocks.historyListRecent.mockReset();
    ipcMocks.historyListRecent.mockResolvedValue(["git pull", "git push"]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when closed", () => {
    render(
      <CommonCommandsPalette
        open={false}
        historyHostKey="local"
        userCommands={[]}
        presets={presets}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fetches history once when opening and shows merged candidates", async () => {
    render(
      <CommonCommandsPalette
        open
        historyHostKey="local"
        userCommands={[{ command: "my-tool", description: "scratch" }]}
        presets={presets}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("git pull");
    expect(ipcMocks.historyListRecent).toHaveBeenCalledTimes(1);
    expect(ipcMocks.historyListRecent).toHaveBeenCalledWith("local", 50);

    expect(screen.getByText("git pull")).toBeTruthy();
    expect(screen.getByText("my-tool")).toBeTruthy();
    expect(screen.getByText("git status")).toBeTruthy();
  });

  it("filters candidates by the search input (case-insensitive)", async () => {
    const user = userEvent.setup();
    render(
      <CommonCommandsPalette
        open
        historyHostKey="local"
        userCommands={[]}
        presets={presets}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("git pull");
    const input = screen.getByLabelText("Filter commands");
    await user.type(input, "IPCONFIG");

    expect(screen.queryByText("git pull")).toBeNull();
    expect(screen.getByText("ipconfig /all")).toBeTruthy();
  });

  it("invokes onPick with the selected command on Enter", async () => {
    const onPick = vi.fn();
    render(
      <CommonCommandsPalette
        open
        historyHostKey="local"
        userCommands={[]}
        presets={presets}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("git pull");
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("git push");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <CommonCommandsPalette
        open
        historyHostKey="local"
        userCommands={[]}
        presets={presets}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );

    await screen.findByText("git pull");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to presets when history fetch fails", async () => {
    ipcMocks.historyListRecent.mockRejectedValueOnce(new Error("boom"));
    render(
      <CommonCommandsPalette
        open
        historyHostKey="local"
        userCommands={[]}
        presets={presets}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("git status");
    expect(screen.queryByText("git pull")).toBeNull();
  });
});
