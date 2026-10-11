// The Vitest projects that make up the Lane workspace: core, web and scripts.
// Vitest 3.2+ replaced the standalone workspace file with `test.projects`, so the
// root `vitest.config.ts` imports this list. Each package also has its own
// `vitest.config.ts`, which `pnpm -r test` uses.
export const laneProjects = [
  "packages/core/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "scripts/vitest.config.ts",
];

export default laneProjects;
