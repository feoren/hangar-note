/// <reference types="node" />
import react from "@vitejs/plugin-react";

import { configDefaults, defineConfig } from "vitest/config";

// Fixed values that Tauri expects (devUrl in src-tauri/tauri.conf.json). Port 1430 keeps the dev
// server apart from Hangar's (1420), so both apps can be developed side by side.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // .claude/worktrees holds agents' working copies; they do not belong in this dev server.
    watch: { ignored: ["**/src-tauri/**", "**/.claude/**"] },
  },
  build: {
    target: "es2022",
    // The note window's chunk is CodeMirror with Markdown (about 510 kB). It loads from the app
    // bundle on disk, never over the network, so the default 500 kB warning does not apply.
    chunkSizeWarningLimit: 700,
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "output/**",
      "release/**",
      "tests/.tmp/**",
    ],
  },
});
