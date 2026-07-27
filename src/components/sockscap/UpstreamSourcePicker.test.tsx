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
  { id: "p1", name: "Office SOCKS", host: "10.0.0.9", port: 1080, kind: "proxy" },
  { id: "s1", name: "Bastion", host: "jump.corp", port: 22, kind: "ssh" },
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
  it("groups detected proxies by client, then proxy sessions, then manual", () => {
    setup();
    const menu = openMenu();
    const headers = within(menu)
      .getAllByText(/Mihomo|Clash Verge|sockscap\.picker/)
      .map((el) => el.textContent);
    // Client group headers present; unknown group uses the generic label.
    expect(within(menu).getByText("Mihomo")).toBeTruthy();
    expect(within(menu).getByText("Clash Verge")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.otherLocal")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.proxySessions")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.manualGroup")).toBeTruthy();
    // SSH sessions must NOT appear in proxy mode.
    expect(within(menu).queryByText("Bastion")).toBeNull();
    expect(headers.length).toBeGreaterThan(0);
  });

  it("emits a detected choice with the candidate", () => {
    const { onSelect } = setup();
    openMenu();
    // The Mihomo option is labelled by its host:port.
    fireEvent.click(screen.getByText("127.0.0.1:7890"));
    expect(onSelect).toHaveBeenCalledWith({
      source: "detected",
      candidate: expect.objectContaining({ port: 7890, kind: "socks5" }),
    });
  });

  it("emits a session choice", () => {
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

  it("filters options and their now-empty group headers", () => {
    setup();
    const menu = openMenu();
    const filter = screen.getByTestId("sockscap-upstream-source-filter");
    fireEvent.change(filter, { target: { value: "20808" } });
    // Only the custom-port unknown proxy matches.
    expect(within(menu).getByText("127.0.0.1:20808")).toBeTruthy();
    expect(within(menu).queryByText("127.0.0.1:7890")).toBeNull();
    // Its group header stays, the Mihomo header is dropped.
    expect(within(menu).getByText("sockscap.picker.otherLocal")).toBeTruthy();
    expect(within(menu).queryByText("Mihomo")).toBeNull();
  });

  it("shows only SSH sessions in ssh mode (no detected proxies)", () => {
    setup({ mode: "ssh", current: { kind: "ssh", sessionId: "", host: "", port: 0 } });
    const menu = openMenu();
    expect(within(menu).getByText("Bastion")).toBeTruthy();
    expect(within(menu).getByText("sockscap.picker.sshSessions")).toBeTruthy();
    // Detected proxies + proxy sessions must be absent.
    expect(within(menu).queryByText("127.0.0.1:7890")).toBeNull();
    expect(within(menu).queryByText("Office SOCKS")).toBeNull();
  });

  it("selects the active option via keyboard (ArrowDown + Enter)", () => {
    const { onSelect } = setup();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    // First option is the Mihomo 7890 entry.
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ source: "detected" }),
    );
  });

  it("triggers rescan from the menu", () => {
    const { onRescan } = setup();
    openMenu();
    fireEvent.click(screen.getByTestId("sockscap-upstream-source-rescan"));
    expect(onRescan).toHaveBeenCalled();
  });
});
