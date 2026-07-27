import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstreamSourcePicker,
  type SessionSource,
  type UpstreamChoice,
} from "./UpstreamSourcePicker";
import type { LocalProxyCandidate } from "../../lib/sockscap";

// Identity translator: return the key so assertions can target stable strings.
const t = (key: string) => key;

const detected: LocalProxyCandidate[] = [
  { kind: "socks5", host: "127.0.0.1", port: 7890, process: "verge-mihomo.exe", pid: 111, client: "mihomo", clientLabel: "Mihomo" },
  { kind: "http", host: "127.0.0.1", port: 7891, process: "clash-verge.exe", pid: 111, client: "clash", clientLabel: "Clash Verge" },
  { kind: "socks5", host: "127.0.0.1", port: 20808, process: "node.exe", pid: 222, client: "unknown", clientLabel: "" },
];

const sessions: SessionSource[] = [
  { id: "p1", name: "Office SOCKS", host: "10.0.0.9", port: 1080, kind: "proxy", groupPath: null },
  { id: "p2", name: "Home SOCKS", host: "10.0.0.5", port: 1081, kind: "proxy", groupPath: "User sessions / Home" },
  { id: "s1", name: "Bastion", host: "jump.corp", port: 22, kind: "ssh", groupPath: null },
];

function setup(overrides: Partial<Parameters<typeof UpstreamSourcePicker>[0]> = {}) {
  const onSelect = vi.fn<(c: UpstreamChoice) => void>();
  const onRescan = vi.fn(async () => {});
  render(
    <UpstreamSourcePicker
      mode="proxy"
      detected={detected}
      sessions={sessions}
      current={{ kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 }}
      onSelect={onSelect}
      onRescan={onRescan}
      t={t}
      {...overrides}
    />,
  );
  return { onSelect, onRescan };
}

function openMenu() {
  fireEvent.click(screen.getByTestId("sockscap-upstream-source"));
  return screen.getByTestId("sockscap-upstream-source-menu");
}

afterEach(cleanup);

describe("UpstreamSourcePicker", () => {
  it("pins Manual as the first option", () => {
    setup();
    openMenu();
    const opts = screen.getAllByTestId("sockscap-upstream-source-option");
    expect(opts[0].getAttribute("data-value")).toBe("__manual__");
  });

  it("shows detected + session sections, with folders collapsed by default", () => {
    setup();
    const menu = openMenu();
    // Section headers.
    expect(within(menu).getByText("sockscap.picker.detectedGroup")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.proxySessions")).toBeTruthy();
    // Detected candidates + ungrouped session are visible under expanded sections.
    expect(within(menu).getByText("127.0.0.1:7890")).toBeTruthy();
    expect(within(menu).getByText("Office SOCKS")).toBeTruthy();
    // Folder node shows, but its child stays hidden until expanded.
    expect(within(menu).getByText("Home")).toBeTruthy();
    expect(within(menu).queryByText("Home SOCKS")).toBeNull();
    // SSH sessions must NOT appear in proxy mode.
    expect(within(menu).queryByText("Bastion")).toBeNull();
  });

  it("expands a folder on click to reveal its sessions", () => {
    const { onSelect } = setup();
    const menu = openMenu();
    fireEvent.click(within(menu).getByText("Home"));
    const homeSocks = within(menu).getByText("Home SOCKS");
    expect(homeSocks).toBeTruthy();
    fireEvent.click(homeSocks);
    expect(onSelect).toHaveBeenCalledWith({
      source: "session",
      session: expect.objectContaining({ id: "p2" }),
    });
  });

  it("collapses a section on click to hide its children", () => {
    setup();
    const menu = openMenu();
    expect(within(menu).getByText("127.0.0.1:7890")).toBeTruthy();
    fireEvent.click(within(menu).getByText("sockscap.picker.detectedGroup"));
    expect(within(menu).queryByText("127.0.0.1:7890")).toBeNull();
  });

  it("emits a detected choice with the candidate", () => {
    const { onSelect } = setup();
    openMenu();
    fireEvent.click(screen.getByText("127.0.0.1:7890"));
    expect(onSelect).toHaveBeenCalledWith({
      source: "detected",
      candidate: expect.objectContaining({ port: 7890, kind: "socks5" }),
    });
  });

  it("emits a session choice for an ungrouped session", () => {
    const { onSelect } = setup();
    openMenu();
    fireEvent.click(screen.getByText("Office SOCKS"));
    expect(onSelect).toHaveBeenCalledWith({
      source: "session",
      session: expect.objectContaining({ id: "p1" }),
    });
  });

  it("emits a manual choice", () => {
    const { onSelect } = setup();
    const menu = openMenu();
    // The trigger label also reads "manual" when nothing is selected, so scope
    // the click to the option inside the menu.
    fireEvent.click(within(menu).getByText("sockscap.manualUpstream"));
    expect(onSelect).toHaveBeenCalledWith({ source: "manual" });
  });

  it("auto-expands the folder holding the current selection", () => {
    setup({ current: { kind: "socks5", sessionId: "p2", host: "10.0.0.5", port: 1081 } });
    const menu = openMenu();
    // Home folder is on the path to the selection, so its child shows at once.
    expect(within(menu).getByText("Home SOCKS")).toBeTruthy();
    // The trigger reflects the selected session name.
    expect(screen.getByTestId("sockscap-upstream-source").textContent).toContain("Home SOCKS");
  });

  it("filters options and auto-expands folders with a match", () => {
    setup();
    const menu = openMenu();
    const filter = screen.getByTestId("sockscap-upstream-source-filter");
    fireEvent.change(filter, { target: { value: "10.0.0.5" } });
    // Only Home SOCKS matches; its folder auto-expands to reveal it.
    expect(within(menu).getByText("Home SOCKS")).toBeTruthy();
    expect(within(menu).getByText("Home")).toBeTruthy();
    // Non-matching options drop out.
    expect(within(menu).queryByText("Office SOCKS")).toBeNull();
    expect(within(menu).queryByText("127.0.0.1:7890")).toBeNull();
  });

  it("shows only SSH sessions in ssh mode (no detected proxies)", () => {
    setup({ mode: "ssh", current: { kind: "ssh", sessionId: "", host: "", port: 0 } });
    const menu = openMenu();
    expect(within(menu).getByText("Bastion")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.sshSessions")).toBeTruthy();
    // Detected proxies + proxy sessions must be absent.
    expect(within(menu).queryByText("127.0.0.1:7890")).toBeNull();
    expect(within(menu).queryByText("Office SOCKS")).toBeNull();
    expect(within(menu).queryByText("sockscap.picker.detectedGroup")).toBeNull();
  });

  it("selects a detected option via keyboard (ArrowDown x2 + Enter)", () => {
    const { onSelect } = setup();
    const menu = openMenu();
    // Row 0 = Manual (active), row 1 = Detected section, row 2 = first candidate.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ source: "detected" }),
    );
  });

  it("expands a folder via ArrowRight", () => {
    setup();
    const menu = openMenu();
    expect(within(menu).queryByText("Home SOCKS")).toBeNull();
    // Move to the Home folder row and expand it.
    fireEvent.click(within(menu).getByText("Home")); // collapse toggles open
    // Re-collapse then drive via keyboard to assert ArrowRight expands.
    fireEvent.click(within(menu).getByText("Home"));
    const homeRow = within(menu).getByText("Home").closest("[data-idx]") as HTMLElement;
    const idx = Number(homeRow.getAttribute("data-idx"));
    // Walk the active cursor down to the Home folder row, then expand.
    for (let i = 0; i < idx; i++) fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    expect(within(menu).getByText("Home SOCKS")).toBeTruthy();
  });

  it("triggers rescan from the menu", () => {
    const { onRescan } = setup();
    openMenu();
    fireEvent.click(screen.getByTestId("sockscap-upstream-source-rescan"));
    expect(onRescan).toHaveBeenCalled();
  });
});
