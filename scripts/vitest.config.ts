import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scripts",
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
