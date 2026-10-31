import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { agGridChunks } from "./scripts/ag-grid-chunks.js";
export default defineConfig({
  plugins: [agGridChunks(), react()],
  // The replay demo must not read .env files, the client included.
  envDir: process.env.DEMO_MODE === "replay" ? false : undefined,
  build: {
    outDir: "dist/client",
    rolldownOptions: { output: { codeSplitting: {
      includeDependenciesRecursively: false,
      groups: [
        { debugName: "AG Grid dependency groups", name: (id) => id.startsWith("\0refunddesk-ag-part-") ? `ag-grid-${id.split("-").at(-1)}` : null, test: (id) => id.startsWith("\0refunddesk-ag-part-") },
        { name: "ag-stack", test: /node_modules[\\/]ag-stack[\\/]/ },
        { name: "ag-grid", test: /node_modules[\\/]ag-grid-community[\\/]/ },
        { name: "ag-react", test: /node_modules[\\/]ag-grid-react[\\/]/ },
      ],
    } } },
  },
  server: {
    port: 15481,
    // Preserve the browser's Host so Hono can validate Origin on local POSTs.
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT || 15480}`, changeOrigin: false } },
  },
});
