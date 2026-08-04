import { describe, expect, it } from "vitest";
import { localProxySnippets } from "./SocksCapPanel";

describe("localProxySnippets", () => {
  it("covers the clients a container user reaches for first", () => {
    const ids = localProxySnippets(7890).map((snippet) => snippet.id);
    expect(ids).toEqual(["env", "curl", "git", "npm"]);
  });

  it("embeds the actual listening port in every snippet", () => {
    for (const snippet of localProxySnippets(41234)) {
      expect(snippet.text).toContain("127.0.0.1:41234");
    }
  });

  it("uses socks5h so DNS resolves at the proxy", () => {
    // socks5 (no h) resolves locally, which leaks lookups and cannot reach names
    // only the upstream can resolve.
    const byId = Object.fromEntries(localProxySnippets(7890).map((s) => [s.id, s.text]));
    expect(byId.env).toContain("ALL_PROXY=socks5h://");
    expect(byId.curl).toContain("socks5h://");
    expect(byId.git).toContain("socks5h://");
  });

  it("exempts loopback from proxying so local services stay reachable", () => {
    const env = localProxySnippets(7890).find((snippet) => snippet.id === "env")!.text;
    expect(env).toContain("no_proxy=localhost,127.0.0.1,::1");
  });
});
