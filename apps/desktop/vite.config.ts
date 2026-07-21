import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/antd") || id.includes("node_modules/@ant-design")) return "vendor-antd";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "vendor-react";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
