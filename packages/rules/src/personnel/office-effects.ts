// T3-09 · AC-M3-12 · D-083
export const officeEffectsConfig = {
  version: 1,
  minimumAbility: 65,
  secretary: true,
  tax: { 3: 10, 4: 10, 11: 5 },
  supplyLoss: { 5: 10, 6: 10, 7: 10, 8: 10, 9: 10, 10: 10 },
} as const;
