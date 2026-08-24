import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: ".",
  optimizeDeps: {
    // @supbot/shared is a linked CJS workspace package; pre-bundle it so
    // named imports work in the dev server.
    include: ["@supbot/shared"],
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
