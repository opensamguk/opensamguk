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
  for (const exemption of exemptions) {
    if (!known.has(exemption.path) || !exemption.reason.trim())
      missing.push(`invalid exemption: ${exemption.path} ${exemption.category}`);
  }
  for (const { path, type } of procedures) {
    for (const category of categories) {
      if (evidence.some((entry) => entry.path === path && entry.category === category)) continue;
      const exemption = exemptions.find((entry) => entry.path === path && entry.category === category);
      if (exemption?.reason.trim()) exempted.push(`${path} ${category}: ${exemption.reason}`);
      else missing.push(`${path} (${type}): ${category}`);
    }
  }
  return { procedures, missing, exempted };
}
