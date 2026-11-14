import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Slot = 'stone' | 'earth' | 'wood' | 'roof' | 'tile' | 'cloth' | 'field' | 'crop' | 'water' | 'flag';
export type ModelPart = { slot: Slot; geometry: BufferGeometry };
type CityLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Wall = 0 | 1 | 2;
export type ModelKind =
  | `city-${CityLevel}`
  | 'pass'
  | 'port'
  | 'camp'
  | 'farm'
  | 'market'
  | 'watchtower'
  | 'barracks'
  | 'houses'
  | 'granary'
  | 'shrine';

type Point = [number, number, number];

class Model {
  private readonly parts = new Map<Slot, BufferGeometry[]>();

  add(slot: Slot, geometry: BufferGeometry) {
    const group = this.parts.get(slot);
    if (group) group.push(geometry);
    else this.parts.set(slot, [geometry]);
  }

  box(slot: Slot, x: number, y: number, z: number, width: number, height: number, depth: number) {
    const indexed = new BoxGeometry(width, height, depth);
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    geometry.deleteAttribute('uv');
    this.add(slot, geometry.translate(x, y + height / 2, z));
  }

  roof(slot: Slot, x: number, y: number, z: number, width: number, depth: number, rise: number, hipped = true) {
    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const eave: Point[] = [
      [-halfWidth, rise * 0.1, -halfDepth],
      [halfWidth, rise * 0.1, -halfDepth],
      [halfWidth, rise * 0.1, halfDepth],
      [-halfWidth, rise * 0.1, halfDepth],
    ];
    // A shallow eave and a steeper upper slope keep the roof legible at map scale.
    const shoulder: Point[] = [
      [-halfWidth * 0.81, rise * 0.25, -halfDepth * 0.72],
      [halfWidth * 0.81, rise * 0.25, -halfDepth * 0.72],
      [halfWidth * 0.81, rise * 0.25, halfDepth * 0.72],
      [-halfWidth * 0.81, rise * 0.25, halfDepth * 0.72],
    ];
    const ridgeWest: Point = [-halfWidth * (hipped ? 0.54 : 0.81), rise, 0];
    const ridgeEast: Point = [halfWidth * (hipped ? 0.54 : 0.81), rise, 0];
    const vertices: number[] = [];
    const triangle = (a: Point, b: Point, c: Point) => vertices.push(...a, ...b, ...c);
    const quad = (a: Point, b: Point, c: Point, d: Point) => {
      triangle(a, b, c);
      triangle(a, c, d);
    };
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      quad(eave[i]!, shoulder[i]!, shoulder[next]!, eave[next]!);
    }
    quad(shoulder[0]!, ridgeWest, ridgeEast, shoulder[1]!);
    triangle(shoulder[1]!, ridgeEast, shoulder[2]!);
    quad(shoulder[2]!, ridgeEast, ridgeWest, shoulder[3]!);
    triangle(shoulder[3]!, ridgeWest, shoulder[0]!);
    quad(eave[0]!, eave[1]!, eave[2]!, eave[3]!);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    this.add(slot, geometry.translate(x, y, z));
  }

  finish(): ModelPart[] {
    return [...this.parts].map(([slot, geometries]) => {
      const geometry = mergeGeometries(geometries);
      for (const part of geometries) part.dispose();
      if (!geometry) throw new Error('Model parts have incompatible geometry attributes');
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return { slot, geometry };
    });
  }
}

function hall(
  model: Model,
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  roof: 'roof' | 'tile' = 'tile',
) {
  model.box('wood', x, y, z, width, height, depth);
  model.roof(roof, x, y + height, z, width * 1.18, depth * 1.28, height * 0.66);
}

function flag(model: Model, x: number, y: number, z: number, height: number) {
  model.box('wood', x, y, z, 0.016, height, 0.016);
  model.box('flag', x + 0.065, y + height * 0.64, z, 0.13, height * 0.31, 0.012);
}

function gate(model: Model, x: number, z: number, height: number, slot: 'stone' | 'earth', tower: boolean) {
  for (const offset of [-0.11, 0.11]) model.box(slot, x + offset, 0, z, 0.09, height, 0.18);
  model.box(slot, x, height * 0.74, z, 0.16, height * 0.26, 0.18);
  if (tower) hall(model, x, height, z, 0.27, 0.18, 0.082, 'roof');
}

function city(model: Model, level: CityLevel, wall: Wall) {
  const side = 0.64 + (level - 1) * 0.032;
  const edge = side / 2;
  const height = [0.075, 0.13, 0.185][wall]!;
  const thickness = [0.06, 0.078, 0.1][wall]!;
  const slot = wall === 0 ? 'earth' : 'stone';
  model.box(slot, 0, 0, -edge, side + thickness, height, thickness);
  for (const x of [-edge, edge]) {
    model.box(slot, x, 0, 0, thickness, height, side);
    const span = edge - 0.12;
    model.box(slot, Math.sign(x) * (0.12 + span / 2), 0, edge, span, height, thickness);
  }
  gate(model, 0, edge - 0.065, height, slot, wall === 2 || (wall === 1 && level >= 4));
  if (wall === 2) {
    for (const x of [-edge, edge]) {
      for (const z of [-edge, edge]) {
        model.box('stone', x, 0, z, 0.13, height + 0.025, 0.13);
        // At maximum city size the towers stay within the one-cell footprint.
        hall(model, x, height + 0.025, z, 0.088, 0.076, 0.055, 'roof');
      }
    }
  }

  const keepWidth = 0.18 + level * 0.019;
  const keepHeight = 0.104 + level * 0.013;
  model.box('stone', 0, 0, -0.15, keepWidth + 0.05, 0.032, 0.2);
  hall(model, 0, 0.032, -0.15, keepWidth, 0.17, keepHeight, 'roof');
  if (level >= 6) hall(model, 0, 0.032 + keepHeight * 1.5, -0.15, keepWidth * 0.55, 0.11, 0.067, 'roof');
  const yards = [
    [-0.16, 0.04],
    [0.16, 0.04],
    [-0.16, 0.21],
    [0.16, 0.21],
    [-0.26, -0.22],
    [0.26, -0.22],
    [-0.25, -0.09],
  ] as const;
  for (const [x, z] of yards.slice(0, level - 1)) hall(model, x, 0, z, 0.1, 0.086, 0.057);
}

function pass(model: Model) {
  for (const side of [-1, 1]) {
    model.box('earth', side * 0.315, 0, 0, 0.37, 0.09, 0.27);
    model.box('stone', side * 0.31, 0.09, 0, 0.36, 0.15, 0.15);
    model.box('stone', side * 0.435, 0.24, 0, 0.105, 0.085, 0.16);
  }
  gate(model, 0, 0, 0.24, 'stone', true);
  flag(model, 0.29, 0.24, -0.035, 0.23);
}

function port(model: Model) {
  model.box('water', 0, 0, 0.19, 0.99, 0.016, 0.6);
  model.box('stone', 0, 0, -0.29, 0.95, 0.068, 0.38);
  for (const x of [-0.24, 0.22]) {
    model.box('wood', x, 0.05, 0.14, 0.12, 0.035, 0.55);
    for (const z of [0.05, 0.31]) model.box('wood', x, 0.016, z, 0.09, 0.05, 0.045);
  }
  hall(model, -0.21, 0.068, -0.3, 0.23, 0.15, 0.1);
  // The small hulls have tapered bows, with a mast on the larger boat.
  for (const [x, z, size] of [
    [0.02, 0.22, 1],
    [0.37, -0.015, 0.72],
  ] as const) {
    model.box('wood', x, 0.016, z, 0.095 * size, 0.035, 0.21 * size);
    const prow = new BoxGeometry(0.06 * size, 0.035, 0.06 * size);
    const geometry = prow
      .toNonIndexed()
      .rotateY(Math.PI / 4)
      .translate(x, 0.0335, z + 0.103 * size);
    prow.dispose();
    geometry.deleteAttribute('uv');
    model.add('wood', geometry);
  }
  model.box('wood', 0.02, 0.051, 0.22, 0.015, 0.19, 0.015);
  model.box('cloth', 0.068, 0.115, 0.22, 0.105, 0.104, 0.014);
}

function camp(model: Model) {
  model.box('earth', 0, 0, 0, 0.91, 0.022, 0.86);
  model.box('wood', 0, 0.022, -0.415, 0.87, 0.095, 0.032);
  for (const side of [-1, 1]) {
    model.box('wood', side * 0.435, 0.022, 0, 0.032, 0.095, 0.84);
    model.box('wood', side * 0.29, 0.022, 0.415, 0.3, 0.095, 0.032);
    for (const z of [-0.4, 0, 0.4]) model.box('wood', side * 0.435, 0.022, z, 0.046, 0.128, 0.046);
    model.box('wood', side * 0.14, 0.022, 0.415, 0.045, 0.15, 0.045);
  }
  for (const [x, z] of [
    [-0.23, -0.19],
    [0.23, -0.19],
    [-0.23, 0.17],
    [0.23, 0.17],
  ] as const) {
    model.box('cloth', x, 0.022, z, 0.19, 0.057, 0.18);
    model.roof('cloth', x, 0.079, z, 0.23, 0.22, 0.13, false);
  }
  flag(model, -0.075, 0.022, -0.035, 0.36);
}

function farm(model: Model) {
  for (const x of [-0.25, 0.22]) {
    model.box('field', x, 0, -0.095, 0.42, 0.028, 0.65);
    for (const row of [-0.135, -0.045, 0.045, 0.135]) {
      model.box('crop', x + row, 0.028, -0.095, 0.035, 0.024, 0.58);
    }
  }
  hall(model, 0.21, 0, 0.35, 0.23, 0.17, 0.11);
}

function market(model: Model) {
  model.box('earth', 0, 0, 0, 0.92, 0.019, 0.87);
  for (const x of [-0.29, 0, 0.29]) {
    model.box('wood', x, 0.019, 0.07, 0.17, 0.06, 0.15);
    for (const dx of [-0.085, 0.085]) model.box('wood', x + dx, 0.019, 0.02, 0.018, 0.15, 0.026);
    model.roof('cloth', x, 0.165, 0.06, 0.24, 0.25, 0.062, false);
  }
  hall(model, 0, 0.019, -0.29, 0.29, 0.17, 0.11);
}

function watchtower(model: Model) {
  model.box('stone', 0, 0, 0, 0.54, 0.064, 0.54);
  for (const x of [-0.19, 0.19]) {
    for (const z of [-0.19, 0.19]) model.box('wood', x, 0.064, z, 0.065, 0.45, 0.065);
  }
  model.box('wood', 0, 0.34, 0, 0.45, 0.064, 0.45);
  model.box('wood', 0, 0.4, -0.19, 0.44, 0.095, 0.065);
  model.roof('tile', 0, 0.514, 0, 0.57, 0.57, 0.155);
  model.box('wood', 0, 0, 0.24, 0.11, 0.19, 0.1);
}

function barracks(model: Model) {
  model.box('earth', 0, 0, 0, 0.94, 0.028, 0.83);
  hall(model, 0, 0.028, -0.255, 0.65, 0.19, 0.126);
  for (const x of [-0.295, 0.295]) hall(model, x, 0.028, 0.06, 0.19, 0.31, 0.09);
  model.box('wood', -0.35, 0.028, 0.34, 0.22, 0.06, 0.035);
  model.box('wood', 0.35, 0.028, 0.34, 0.22, 0.06, 0.035);
  flag(model, -0.12, 0.028, 0.34, 0.28);
}

function houses(model: Model) {
  model.box('earth', 0, 0, 0, 0.89, 0.018, 0.77);
  hall(model, -0.24, 0.018, -0.16, 0.28, 0.21, 0.105);
  hall(model, 0.21, 0.018, -0.055, 0.31, 0.235, 0.134);
  hall(model, -0.135, 0.018, 0.26, 0.23, 0.15, 0.077);
}

function granary(model: Model) {
  for (const x of [-0.28, 0, 0.28]) {
    for (const z of [-0.19, 0.19]) model.box('stone', x, 0, z, 0.09, 0.115, 0.09);
  }
  model.box('wood', 0, 0.115, 0, 0.68, 0.045, 0.49);
  hall(model, 0, 0.16, 0, 0.64, 0.45, 0.22);
  model.box('wood', 0, 0.052, 0.31, 0.16, 0.11, 0.12);
  model.box('wood', 0, 0, 0.4, 0.21, 0.052, 0.14);
}

function shrine(model: Model) {
  model.box('stone', 0, 0, 0.025, 0.85, 0.049, 0.78);
  model.box('stone', 0, 0.049, -0.065, 0.7, 0.075, 0.54);
  model.box('stone', 0, 0.049, 0.285, 0.26, 0.037, 0.135);
  hall(model, 0, 0.124, -0.12, 0.5, 0.31, 0.18, 'roof');
  for (const x of [-0.19, 0.19]) model.box('wood', x, 0.124, 0.093, 0.055, 0.19, 0.055);
}

const buildings = { pass, port, camp, farm, market, watchtower, barracks, houses, granary, shrine };
const cityLevels = {
  'city-1': 1,
  'city-2': 2,
  'city-3': 3,
  'city-4': 4,
  'city-5': 5,
  'city-6': 6,
  'city-7': 7,
  'city-8': 8,
} as const;

/** Each call returns fresh, caller-owned geometry. Parts share the same origin and scale. */
export function buildModel(kind: ModelKind, options?: { wall?: Wall }): ModelPart[] {
  const model = new Model();
  if (kind in buildings) buildings[kind as keyof typeof buildings](model);
  else city(model, cityLevels[kind as keyof typeof cityLevels], options?.wall ?? 1);
  return model.finish();
}
