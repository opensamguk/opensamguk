import {
  BoxGeometry,
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Shape,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Slot = 'stone' | 'earth' | 'wood' | 'roof' | 'tile' | 'cloth' | 'field' | 'crop' | 'water' | 'flag';
export type ModelPart = { slot: Slot; geometry: BufferGeometry };
type CityLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type ModelLod = 0 | 1 | 2;
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

export const CITY_PLINTH_SCALE = 1.35;

type Point = [number, number, number];

class Model {
  private readonly parts = new Map<Slot, BufferGeometry[]>();

  constructor(readonly lod: ModelLod) {}

  add(slot: Slot, geometry: BufferGeometry) {
    const group = this.parts.get(slot);
    if (group) group.push(geometry);
    else this.parts.set(slot, [geometry]);
  }

  box(slot: Slot, x: number, y: number, z: number, width: number, height: number, depth: number) {
    const indexed = new BoxGeometry(width, height, depth);
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    this.add(slot, geometry.translate(x, y + height / 2, z));
  }

  rock(x: number, z: number, width: number, height: number, depth: number, angle: number) {
    const geometry = new IcosahedronGeometry(1, [2, 1, 0][this.lod]!);
    geometry.scale(width, height, depth).rotateY(angle).translate(x, height, z);
    this.add('rock', geometry);
  }

  roof(slot: Slot, x: number, y: number, z: number, width: number, depth: number, rise: number, hipped = true) {
    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const bands = [9, 4, 1][this.lod]!;
    const segments = [12, 2, 1][this.lod]!;
    const ridgeRatio = hipped ? 0.54 : 1;
    const vertices: number[] = [];
    const uv: number[] = [];
    const triangle = (a: Point, b: Point, c: Point) => {
      for (const point of [a, b, c]) {
        vertices.push(...point);
        uv.push(0.5 + point[0] / width, 0.5 + point[2] / depth);
      }
    };
    const quad = (a: Point, b: Point, c: Point, d: Point) => {
      triangle(a, b, c);
      triangle(a, c, d);
    };
    const ring = (t: number): Point[] => {
      const w = halfWidth * (1 - (1 - ridgeRatio) * t);
      const d = halfDepth * (1 - t);
      return [
        [-w, 0, -d],
        [w, 0, -d],
        [w, 0, d],
        [-w, 0, d],
      ];
    };
    const point = (side: number, u: number, t: number): Point => {
      const corners = ring(t);
      const a = corners[side]!;
      const b = corners[(side + 1) % 4]!;
      const lift = this.lod === 2 ? 0 : 0.19 * (2 * u - 1) ** 4 * (1 - t) ** 3;
      return [a[0] + (b[0] - a[0]) * u, rise * (0.08 + 0.92 * t ** 1.65 + lift), a[2] + (b[2] - a[2]) * u];
    };
    for (let side = 0; side < 4; side++) {
      for (let row = 0; row < bands; row++) {
        const t0 = row / bands;
        const t1 = (row + 1) / bands;
        for (let col = 0; col < segments; col++) {
          const u0 = col / segments;
          const u1 = (col + 1) / segments;
          const a = point(side, u0, t0);
          const b = point(side, u0, t1);
          const c = point(side, u1, t1);
          const d = point(side, u1, t0);
          if (row === bands - 1 && side % 2 === 1) triangle(a, b, d);
          else quad(a, b, c, d);
        }
      }
    }
    for (let side = 0; this.lod !== 2 && side < 4; side++) {
      for (let col = 0; col < segments; col++) {
        const a = point(side, col / segments, 0);
        const b = point(side, (col + 1) / segments, 0);
        quad([a[0], 0, a[2]], a, b, [b[0], 0, b[2]]);
      }
    }
    const eave = ring(0);
    quad(eave[0]!, eave[1]!, eave[2]!, eave[3]!);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geometry.computeVertexNormals();
    this.add(slot, geometry.translate(x, y, z));
    if (this.lod !== 2 && (slot === 'tile' || slot === 'roof' || slot === 'glazed-tile')) {
      const ridge = Math.min(width, depth) * 0.06;
      this.box(slot, x, y + rise - ridge / 2, z, width * ridgeRatio, ridge, ridge);
    }
  }

  arch(slot: 'stone' | 'earth', x: number, z: number, height: number, depth: number) {
    const radius = 0.073;
    const spring = height * 0.46;
    const steps = this.lod === 0 ? 20 : 8;
    const path = new Shape();
    path.moveTo(-0.155, 0);
    path.lineTo(-radius, 0);
    for (let i = 0; i <= steps; i++) {
      const angle = Math.PI * (1 - i / steps);
      path.lineTo(radius * Math.cos(angle), spring + height * 0.32 * Math.sin(angle));
    }
    path.lineTo(radius, 0);
    path.lineTo(0.155, 0);
    path.lineTo(0.155, height);
    path.lineTo(-0.155, height);
    path.closePath();
    this.add(slot, new ExtrudeGeometry(path, { depth, bevelEnabled: false }).translate(x, 0, z - depth / 2));
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
  roof: 'roof' | 'tile' | 'glazed-tile' = 'tile',
) {
  model.box('plaster', x, y, z, width, height, depth);
  if (model.lod === 0) {
    const post = Math.min(width, depth) * 0.075;
    for (const side of [-1, 1]) {
      for (const column of [-0.45, 0, 0.45]) {
        model.box('wood', x + width * column, y, z + (side * depth) / 2, post, height, post);
      }
      model.box('wood', x, y + height * 0.79, z + (side * depth) / 2, width * 1.06, height * 0.16, post);
    }
    model.box('wood', x, y, z + depth / 2, width * 0.22, height * 0.61, post * 1.25);
  }
  model.roof(roof, x, y + height, z, width * 1.18, depth * 1.28, height * 0.66);
}

function flag(model: Model, x: number, y: number, z: number, height: number) {
  model.box('wood', x, y, z, 0.016, height, 0.016);
  model.box('flag', x + 0.065, y + height * 0.64, z, 0.13, height * 0.31, 0.012);
}

function gate(model: Model, x: number, z: number, height: number, slot: 'stone' | 'earth', tower: boolean) {
  if (model.lod === 2) {
    for (const offset of [-0.11, 0.11]) model.box(slot, x + offset, 0, z, 0.09, height, 0.18);
    model.box(slot, x, height * 0.74, z, 0.16, height * 0.26, 0.18);
  } else {
    model.arch(slot, x, z, height, 0.18);
  }
  if (tower) {
    hall(model, x, height, z, 0.27, 0.18, 0.082, 'roof');
    if (model.lod !== 2) hall(model, x, height + 0.123, z, 0.18, 0.111, 0.064, 'roof');
  }
}

function curtain(
  model: Model,
  slot: 'stone' | 'earth',
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
) {
  model.box(slot, x, 0, z, width, height, depth);
  if (model.lod === 2) return;
  const across = width > depth;
  const length = across ? width : depth;
  const teeth = Math.max(2, Math.round(length / (model.lod === 0 ? 0.034 : 0.082)));
  for (let i = 0; i < teeth; i++) {
    const step = length / teeth;
    const offset = (i + 0.5) * step - length / 2;
    model.box(
      slot,
      x + (across ? offset : 0),
      height,
      z + (across ? 0 : offset),
      across ? step * 0.58 : 0.024,
      0.018,
      across ? 0.024 : step * 0.58,
    );
  }
  if (slot === 'earth' && model.lod === 0) {
    for (const y of [0.2, 0.4, 0.6, 0.8])
      model.box('earth', x, y * height, z, across ? width : width + 0.004, 0.004, across ? depth + 0.004 : depth);
  }
}

function city(model: Model, level: CityLevel, wall: Wall, capital: boolean) {
  const side = 0.64 + (level - 1) * 0.032;
  const edge = side / 2;
  const height = [0.075, 0.13, 0.185][wall]! * (level < 4 ? 0.7 : level < 6 ? 0.85 : 1);
  const thickness = [0.06, 0.078, 0.1][wall]!;
  const slot = level < 4 ? 'earth' : 'stone';
  const plinth = 0.028;
  model.box('earth', 0, 0, 0, 1, plinth, 1);
  const fort = new Model(model.lod);
  curtain(fort, slot, 0, -edge, side + thickness, thickness, height);
  for (const x of [-edge, edge]) {
    curtain(fort, slot, x, 0, thickness, side, height);
    const span = edge - 0.12;
    curtain(fort, slot, Math.sign(x) * (0.12 + span / 2), edge, span, thickness, height);
  }
  gate(fort, 0, edge - 0.065, height, slot, level >= 6 || (level >= 4 && wall >= 1));
  if (model.lod === 0 && level >= 4) {
    const inner = edge + 0.047;
    const outer = 0.495;
    const strip = outer - inner;
    const center = (outer + inner) / 2;
    fort.box('water', 0, 0, -center, outer * 2, 0.012, strip);
    fort.box('water', 0, 0, center, outer * 2, 0.012, strip);
    for (const x of [-center, center]) fort.box('water', x, 0, 0, strip, 0.012, inner * 2);
    fort.box('wood', 0, 0.012, center, 0.13, 0.02, strip + 0.009);
    for (const x of [-0.057, 0.057]) fort.box('wood', x, 0.032, center, 0.012, 0.019, strip + 0.009);
  }
  if (level >= 6 || (level >= 4 && wall === 2)) {
    for (const x of [-edge, edge]) {
      for (const z of [-edge, edge]) {
        fort.box('stone', x, 0, z, 0.13, height + 0.025, 0.13);
        // At maximum city size the towers stay within the one-cell footprint.
        if (model.lod !== 2) hall(fort, x, height + 0.025, z, 0.088, 0.076, 0.055, 'roof');
      }
    }
  }

  const keepWidth = 0.18 + level * 0.019;
  const keepHeight = 0.104 + level * 0.013;
  fort.box('stone', 0, 0, -0.15, keepWidth + 0.05, 0.032, 0.2);
  hall(fort, 0, 0.032, -0.15, keepWidth, 0.17, keepHeight, capital ? 'glazed-tile' : 'roof');
  if (level >= 6 && model.lod !== 2)
    hall(fort, 0, 0.032 + keepHeight * 1.5, -0.15, keepWidth * 0.55, 0.11, 0.067, capital ? 'glazed-tile' : 'roof');
  const yards = [
    [-0.16, 0.04],
    [0.16, 0.04],
    [-0.16, 0.21],
    [0.16, 0.21],
    [-0.26, -0.22],
    [0.26, -0.22],
    [-0.25, -0.09],
  ] as const;
  for (const [x, z] of yards.slice(0, Math.min(level + 1, model.lod === 2 ? 3 : yards.length)))
    hall(fort, x, 0, z, 0.1, 0.086, 0.057);
  if (model.lod !== 2 && level >= 4) {
    fort.box('road', 0, 0, 0.135, 0.028, 0.006, edge * 1.14);
    for (const z of [0.122, 0.29]) fort.box('road', 0, 0.001, z, side * 0.79, 0.006, 0.023);
    for (const x of [-0.22, 0.22]) fort.box('road', x, 0.001, 0.064, 0.02, 0.006, side * 0.68);
  }
  for (const { slot, geometry } of fort.finish()) model.add(slot, geometry.translate(0, plinth, 0));
}

function pass(model: Model) {
  for (const side of [-1, 1]) {
    model.rock(side * 0.34, -0.105, 0.145, 0.24 + (side > 0 ? 0.05 : 0), 0.23, side * 0.18);
    if (model.lod !== 2) model.rock(side * 0.36, 0.14, 0.12, 0.145, 0.16, side * 0.34);
    model.box('earth', side * 0.315, 0, 0, 0.37, 0.09, 0.27);
    curtain(model, 'stone', side * 0.31, 0, 0.36, 0.15, 0.24);
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
  if (model.lod !== 2) {
    const x = 0.34;
    const z = 0.31;
    for (const dx of [-0.048, 0.048]) {
      for (const dz of [-0.044, 0.044]) model.box('wood', x + dx, 0.022, z + dz, 0.018, 0.19, 0.018);
    }
    model.box('wood', x, 0.148, z, 0.116, 0.029, 0.105);
    model.roof('wood', x, 0.212, z, 0.14, 0.13, 0.048);
  }
}

function farm(model: Model) {
  for (const x of [-0.25, 0.22]) {
    model.box('field', x, 0, -0.095, 0.42, 0.028, 0.65);
    if (model.lod !== 2) {
      for (const edge of [-0.413, 0.223]) model.box('earth', x, 0.028, edge, 0.42, 0.018, 0.012);
    }
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
export function buildModel(kind: ModelKind, options?: { wall?: Wall; lod?: ModelLod; capital?: boolean }): ModelPart[] {
  const model = new Model(options?.lod ?? 0);
  if (kind in buildings) buildings[kind as keyof typeof buildings](model);
  else city(model, cityLevels[kind as keyof typeof cityLevels], options?.wall ?? 1, options?.capital ?? false);
  return model.finish();
}
