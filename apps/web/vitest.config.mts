import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
