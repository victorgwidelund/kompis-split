import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: frontendRoot,
  publicDir: false,
  plugins: [
    react(),
    {
      name: "kompis-split-static-assets",
      closeBundle() {
        for (const file of ["styles.css", "manifest.json", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
          copyFileSync(resolve(frontendRoot, "../public", file), resolve(frontendRoot, "dist", file));
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
});
