import path from "node:path";
import type { NextConfig } from "next";

// The pnpm workspace root, two levels up from apps/web.
const workspaceRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  // @lane/core ships TypeScript source through subpath exports.
  transpilePackages: ["@lane/core"],
  // The MongoDB driver loads optional native modules at runtime; keep it out of the bundle.
  serverExternalPackages: ["mongodb"],
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
