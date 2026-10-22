export const categories = ['success', 'unauthenticated', 'otherUser', 'sanctioned', 'invalidInput'] as const;
export type Category = (typeof categories)[number];
export interface AuthzEvidence {
  path: string;
  category: Category;
}
export interface AuthzExemption extends AuthzEvidence {
  reason: string;
}
type ProcedureRouter = { _def: { procedures: Record<string, { _def: { type: string } }> } };

export function compareAuthz(
  router: ProcedureRouter,
  evidence: readonly AuthzEvidence[],
  exemptions: readonly AuthzExemption[],
) {
  const procedures = Object.entries(router._def.procedures).map(([path, procedure]) => ({
    path,
    type: procedure._def.type,
  }));
  const missing: string[] = [];
  const exempted: string[] = [];
  const known = new Set(procedures.map(({ path }) => path));
  const grouped = new Map<string, AuthzExemption[]>();
  for (const exemption of exemptions) {
    const key = JSON.stringify([exemption.path, exemption.category]);
    const entries = grouped.get(key) ?? [];
    entries.push(exemption);
    grouped.set(key, entries);
  }
  const validExemptions: AuthzExemption[] = [];
  for (const entries of grouped.values()) {
    const exemption = entries[0]!;
    const { path, category } = exemption;
    const invalid = !known.has(path) || entries.some((entry) => !entry.reason.trim());
    const duplicate = entries.length > 1;
    const stale = evidence.some((entry) => entry.path === path && entry.category === category);
    if (invalid) missing.push(`invalid exemption: ${path} ${category}`);
    if (duplicate) missing.push(`duplicate exemption: ${path} ${category}`);
    if (stale) missing.push(`stale exemption: ${path} ${category}`);
    if (!invalid && !duplicate && !stale) validExemptions.push(exemption);
  }
  for (const { path, type } of procedures) {
    for (const category of categories) {
      if (evidence.some((entry) => entry.path === path && entry.category === category)) continue;
      const exemption = validExemptions.find((entry) => entry.path === path && entry.category === category);
      if (exemption) exempted.push(`${path} ${category}: ${exemption.reason}`);
      else missing.push(`${path} (${type}): ${category}`);
    }
  }
  return { procedures, missing, exempted };
}
