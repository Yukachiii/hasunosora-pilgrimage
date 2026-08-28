import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "github-pages",
  base: "/hasunosora-pilgrimage/",
  envDir: "..",
  publicDir: resolve("public"),
  plugins: [react()],
  build: {
    outDir: "../pages-dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve("github-pages/index.html"),
      },
    },
  },
});
