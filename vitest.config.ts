import { defineConfig } from "vitest/config";
import { laneProjects } from "./vitest.workspace";

// Running `pnpm vitest` at the root runs every project in vitest.workspace.ts.
export default defineConfig({
  test: {
    projects: laneProjects,
  },
});
