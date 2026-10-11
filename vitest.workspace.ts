// The Vitest projects that make up the Lane workspace: core, web and scripts.
// Vitest 3.2+ replaced the standalone workspace file with `test.projects`, so the
// root `vitest.config.ts` imports this list. Each package also has its own
// `vitest.config.ts`, which `pnpm -r test` uses.
export const laneProjects = [
  "packages/core/vitest.config.ts",
  // .mts because apps/web is CommonJS for next.config.ts.
  "apps/web/vitest.config.mts",
  "scripts/vitest.config.ts",
];

export default laneProjects;
