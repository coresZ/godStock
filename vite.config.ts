import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2021",
    assetsInlineLimit: 0,
    cssMinify: "esbuild",
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
