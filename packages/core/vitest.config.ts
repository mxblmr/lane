import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The in-memory replica set downloads a MongoDB binary on first use.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
