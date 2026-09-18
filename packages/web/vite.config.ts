import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bound explicitly so the dev server is served at the exact origin the
    // OAuth app registers as its homepage.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
    // Vitest 5 narrowed its default `exclude` to just node_modules/.git,
    // dropping the old **/dist/** entry. Without this, a leftover local
    // `vite build` output under `dist/` gets picked up and run as tests.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
