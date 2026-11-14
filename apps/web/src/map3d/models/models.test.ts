import { describe, expect, it } from 'vitest';
import { buildModel, type ModelKind, type ModelLod } from './index';

const cities = ['city-1', 'city-2', 'city-3', 'city-4', 'city-5', 'city-6', 'city-7', 'city-8'] as const;
const buildings = ['farm', 'market', 'watchtower', 'barracks', 'houses', 'granary', 'shrine'] as const;
const kinds = [
  ...cities.flatMap((kind) => ([0, 1, 2] as const).map((wall) => ({ kind, wall }))),
  ...(['pass', 'port', 'camp', ...buildings] as const).map((kind) => ({ kind, wall: 1 as const })),
] satisfies { kind: ModelKind; wall: 0 | 1 | 2 }[];
const cases = kinds.flatMap((entry) =>
  ([0, 1, 2] as const).map((lod) => ({ ...entry, lod, budget: [25000, 3000, 400][lod]! })),
);

describe('INT-27 model geometry', () => {
  it.each(cases)('$kind wall=$wall lod=$lod fits its footprint and triangle budget', ({ kind, wall, lod, budget }) => {
    const parts = buildModel(kind, { wall, lod });
    try {
      expect(new Set(parts.map(({ slot }) => slot)).size).toBe(parts.length);
      let lowest = Infinity;
      let triangles = 0;
      for (const { geometry } of parts) {
        const bounds = geometry.boundingBox!;
        const positions = geometry.getAttribute('position');
        expect(bounds.min.x).toBeGreaterThanOrEqual(-0.5 - 1e-6);
        expect(bounds.max.x).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(bounds.min.z).toBeGreaterThanOrEqual(-0.5 - 1e-6);
        expect(bounds.max.z).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(bounds.min.y).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.max.y).toBeGreaterThan(0);
        expect(geometry.getAttribute('normal').count).toBe(positions.count);
        const uv = geometry.getAttribute('uv');
        expect(uv.itemSize).toBe(2);
        expect(uv.count).toBe(positions.count);
        expect(uv.array.every(Number.isFinite)).toBe(true);
        expect(uv.array.some((value) => value !== 0)).toBe(true);
        lowest = Math.min(lowest, bounds.min.y);
        triangles += (geometry.index?.count ?? positions.count) / 3;
      }
      expect(lowest).toBeCloseTo(0, 6);
      expect(triangles).toBeGreaterThan(0);
      expect(triangles).toBeLessThanOrEqual(budget);
    } finally {
      parts.forEach(({ geometry }) => geometry.dispose());
    }
  });

  it('uses earth for the low curtain wall and adds roofed towers to the high wall', () => {
    const low = buildModel('city-1', { wall: 0 });
    const high = buildModel('city-1', { wall: 2 });
    try {
      expect(low.some(({ slot }) => slot === 'earth')).toBe(true);
      expect(high.some(({ slot }) => slot === 'earth')).toBe(false);
      const roofVertices = (parts: typeof low) =>
        parts.find(({ slot }) => slot === 'roof')!.geometry.getAttribute('position').count;
      expect(roofVertices(high)).toBeGreaterThan(roofVertices(low));
    } finally {
      [...low, ...high].forEach(({ geometry }) => geometry.dispose());
    }
  });
  it.each(kinds)('$kind wall=$wall simplifies at every distance', ({ kind, wall }) => {
    const triangles = (lod: ModelLod) => {
      const parts = buildModel(kind, { lod, wall });
      const count = parts.reduce((sum, { geometry }) => sum + geometry.getAttribute('position').count / 3, 0);
      parts.forEach(({ geometry }) => geometry.dispose());
      return count;
    };
    const mid = triangles(1);
    expect(triangles(0)).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(triangles(2));
  });
});
