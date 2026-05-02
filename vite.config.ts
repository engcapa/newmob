import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { sshProxyPlugin } from "./vite-plugins/sshProxy";

const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [react(), ...(isTauriBuild ? [] : [sshProxyPlugin()])],
  clearScreen: false,
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
    port: 5000,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: true,
  },
});
