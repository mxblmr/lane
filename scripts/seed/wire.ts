import { provideServices, SERVICE_OWNERS, type ServiceName, type ServiceOverrides } from "@lane/core/interfaces";
import { stageService } from "./reset";

/**
 * Wire the real unit services into U3's services table for the seed CLI, which runs outside the
 * web app's composition root. Owner modules are loaded by name when they exist; a unit that has
 * not merged yet stays a stub, and calling it fails with an error naming its owner.
 *
 * Each owner exports `<service>Service` objects (for example U6's `challengesService`) and may
 * export a `provide*Services()` function (for example U18's `provideU18Services`).
 */
export const OWNER_MODULES = [
  "@lane/core/players",
  "@lane/core/challenges",
  "@lane/core/contracts",
  "@lane/core/inbox",
  "@lane/core/checkin",
  "@lane/core/feed",
  "@lane/core/tick",
  "@lane/core/rules/engine",
  "@lane/core/rules/lifecycle",
  "@lane/core/rules/approvals",
  "@lane/core/rules/learning",
  "@lane/core/agents/client",
  "@lane/core/proofs/pipeline",
  "@lane/core/settlement/index",
] as const;

const SERVICE_NAMES = new Set(Object.keys(SERVICE_OWNERS));

export interface WireReport {
  loaded: string[];
  missing: string[];
  provided: ServiceName[];
}

export async function wireServices(importer: (spec: string) => Promise<Record<string, unknown>> = (s) => import(s)): Promise<WireReport> {
  const report: WireReport = { loaded: [], missing: [], provided: [] };
  const overrides: ServiceOverrides = {};
  const providers: (() => unknown)[] = [];
  for (const spec of OWNER_MODULES) {
    let mod: Record<string, unknown>;
    try {
      mod = await importer(spec);
    } catch {
      report.missing.push(spec);
      continue;
    }
    report.loaded.push(spec);
    for (const [name, value] of Object.entries(mod)) {
      const match = /^(\w+)Service$/.exec(name);
      if (match && SERVICE_NAMES.has(match[1]!) && value && typeof value === "object") {
        (overrides as Record<string, unknown>)[match[1]!] = value;
        report.provided.push(match[1] as ServiceName);
      } else if (/^provide\w*Services$/.test(name) && typeof value === "function") {
        providers.push(value as () => unknown);
      }
    }
  }
  for (const provide of providers) await provide();
  provideServices({ ...overrides, stage: stageService });
  report.provided.push("stage");
  return report;
}
