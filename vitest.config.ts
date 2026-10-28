import { defineConfig } from "vitest/config";
import { substrateData } from "./substrate.paths";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { preserveSymlinks: true, dedupe: ["react", "react-dom"], alias: { "substrate-data": substrateData } },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/cliService.ts"],
    benchmark: { include: ["src/**/*.bench.{ts,tsx}"] },
  },
});
