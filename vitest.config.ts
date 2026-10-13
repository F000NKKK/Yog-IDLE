import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { preserveSymlinks: true, dedupe: ["react", "react-dom"] },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    benchmark: { include: ["src/**/*.bench.{ts,tsx}"] },
  },
});
