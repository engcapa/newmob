import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";
import { sshProxyPlugin } from "./vite-plugins/sshProxy";
import { sftpProxyPlugin } from "./vite-plugins/sftpProxy";

const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

const devPort = isTauriBuild ? 1420 : 5000;

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react(), ...(isTauriBuild ? [] : [sshProxyPlugin(), sftpProxyPlugin()])],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    include: ["zmodem.js"],
  },
  // Tauri 2 targets modern WebView2 / WebKitGTK / WKWebView, all of which
  // support ES2022. Staying on the default (esnext/modules) target means
  // esbuild does not down-level syntax like `||=`. We previously hit a
  // ReferenceError in xterm's `requestMode` because a default low target
  // mis-compiled `r ||= {}` and dropped the `let r` declaration, making
  // `vi` (which sends DECRQM queries) crash the parser.
  esbuild: {
    target: "es2022",
  },
  build: {
    target: "es2022",
  },
  resolve: {
    alias: isTauriBuild
      ? {}
      : {
          "@tauri-apps/api/window": resolve(__dirname, "src/stubs/tauri-window.ts"),
          "@tauri-apps/api/core": resolve(__dirname, "src/stubs/tauri-core.ts"),
          "@tauri-apps/api/event": resolve(__dirname, "src/stubs/tauri-event.ts"),
          "@tauri-apps/plugin-shell": resolve(__dirname, "src/stubs/tauri-shell.ts"),
        },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: true,
  },
});
