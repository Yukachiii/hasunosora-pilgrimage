import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "local-admin",
  base: "/admin/",
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
  plugins: [react()],
  build: {
    outDir: "../admin-dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
