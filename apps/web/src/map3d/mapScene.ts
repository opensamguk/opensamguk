// 3D 군략도 장면 (INT-27, D-089). three.js를 직접 써서 지형·숲·거점 모형·길·선택 고리를 그린다.
// react-three-fiber는 쓰지 않는다. 그 패키지 정보(외부 주소)가 번들에 들어가 공개 자산 검사에 걸리고,
// three 전체를 묶어 덩어리가 커진다. 필요한 부품만 가져온다.
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { PublicGeography } from '@opensamguk/shared';
import { roadWalks, waterLanes, type Terrain } from '../main/terrainTiles';
import { ROAD_CELL } from '../main/roadPixels';
import { bounds as riverBounds, lines as riverData } from './data/rivers';
import { along, cellsToPoints, simplify } from './routes3d';
import type { DrawnNation } from '../main/siteMarkers';
import type { ModelCity } from '../main/mapModel';
import {
  cellNoise,
  decodeMetres,
  groundAt,
  heightField,
  heightFieldFromMetres,
  realisticColors,
  siteSize,
  treeSpots,
  type HeightData,
  type TerrainCells,
} from './terrain3d';

type Site = PublicGeography['sites'][number];
export type AnchorSite = Site & { anchorKey: number };

// 위에서 내려다보는 각도(수평에서 55°). 화면 위쪽이 북쪽이다.
export const ELEVATION = (55 * Math.PI) / 180;
const NEUTRAL = '#d6d0c4';
const WALL = '#cbbd9e';

export type CameraState = { x: number; z: number; zoom: number };

export class MapScene {
  readonly renderer: WebGLRenderer;
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -4000, 4000);
  private readonly scene = new Scene();
  private readonly canvasSize: { width: number; height: number };
  private readonly field: Float32Array;
  private readonly grid: TerrainCells;
  private models: Mesh[] = [];
  private ring: Mesh | null = null;
  private armies: Mesh[] = [];
  private march: {
    points: Array<{ x: number; y: number }>;
    mesh: InstancedMesh;
    flags: InstancedMesh;
    trail: Mesh;
  } | null = null;
  /** 길 이름(route id)마다 지도 좌표의 점 목록. 행군 경로를 이을 때 쓴다. */
  readonly routeLines = new Map<string, Array<{ x: number; y: number }>>();
  private width = 1;
  private height = 1;

  constructor(
    canvas: HTMLCanvasElement,
    {
      map,
      grid,
      heights,
      palette,
      bounds,
    }: {
      map: PublicGeography;
      grid: TerrainCells;
      heights: HeightData | null;
      palette: Record<Terrain, string>;
      /** 지도 판의 경위도 범위 [서, 남, 동, 북]. 강 선을 이 판 좌표로 옮길 때 쓴다. */
      bounds: readonly number[];
    },
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvasSize = map.canvas;
    this.grid = grid;
    const metres = heights ? decodeMetres(heights) : null;
    this.field = metres ? heightFieldFromMetres(grid, metres) : heightField(grid);

    this.scene.add(new HemisphereLight('#f6f0e0', '#3e3222', 0.7));
    this.scene.add(new AmbientLight('#ffffff', 0.15));
    const sun = new DirectionalLight('#fff1d8', 2.8);
    sun.position.set(-520, 360, -300);
    this.scene.add(sun);

    this.scene.add(this.terrain(palette, metres));
    const water = new Mesh(
      new PlaneGeometry(map.canvas.width * 1.6, map.canvas.height * 1.6),
      new MeshStandardMaterial({ color: '#2f5f80', roughness: 0.3, metalness: 0.15, transparent: true, opacity: 0.9 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.05;
    this.scene.add(water);
    for (const mesh of this.roads(map)) this.scene.add(mesh);
    this.scene.add(this.rivers(bounds));
    this.scene.add(this.trees(map, metres));
  }

  /** 지도 좌표 (x, y)를 땅 위 3D 위치로. lift만큼 띄운다. */
  world(x: number, y: number, lift = 0) {
    const ground = groundAt(this.field, this.grid, this.canvasSize, x, y);
    return new Vector3(x - this.canvasSize.width / 2, ground + lift, y - this.canvasSize.height / 2);
  }

  // 지형: 칸 하나에 꼭짓점 하나. 위가 북쪽(z 음수)이다. 색은 sRGB라 그리기 전에 선형으로 바꾼다.
  private terrain(palette: Record<Terrain, string>, metres: Float32Array | null) {
    const { width, height } = this.canvasSize;
    const geometry = new PlaneGeometry(width, height, this.grid.columns - 1, this.grid.rows - 1);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setY(i, this.field[i]!);
    const colors = realisticColors(this.grid, palette, this.field, metres);
    const linear = new Color();
    for (let i = 0; i < colors.length; i += 3) {
      linear.setRGB(colors[i]!, colors[i + 1]!, colors[i + 2]!).convertSRGBToLinear();
      colors[i] = linear.r;
      colors[i + 1] = linear.g;
      colors[i + 2] = linear.b;
    }
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  }

  // 지형 위에 붙는 띠. 점마다 진행 방향에 수직으로 폭을 벌린다. 여러 줄을 한 기하로 모은다.
  private ribbon(lines: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>, width: number, lift: number) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const line of lines) {
      if (line.length < 2) continue;
      const start = positions.length / 3;
      for (let i = 0; i < line.length; i++) {
        const prev = line[Math.max(i - 1, 0)]!;
        const next = line[Math.min(i + 1, line.length - 1)]!;
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = (-dy / length) * (width / 2);
        const ny = (dx / length) * (width / 2);
        const point = line[i]!;
        const left = this.world(point.x + nx, point.y + ny, lift);
        const right = this.world(point.x - nx, point.y - ny, lift);
        positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
        if (i > 0) {
          const a = start + (i - 1) * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  // 길: SVG 지도와 같은 칸 길(산을 돌고 물을 짧게 건넌다)을 흙길 띠로, 다리·나루는 색을 달리한다.
  // 바다·큰 강을 건너는 뱃길은 옅은 물길 띠로 그린다.
  private roads(map: PublicGeography) {
    const lanes = waterLanes(map, this.grid as never);
    const laneIds = new Set(lanes.map((lane) => lane.id));
    const walks = roadWalks(map, laneIds, () => 0, ROAD_CELL, this.grid as never);
    const modes = new Map(map.routes.map((route) => [route.id, route.mode]));
    const groups: Record<string, Array<Array<{ x: number; y: number }>>> = { LAND: [], BRIDGE: [], FORD: [], SEA: [] };
    for (const [id, cells] of walks) {
      const points = simplify(cellsToPoints(cells));
      this.routeLines.set(id, points);
      const mode = modes.get(id) ?? 'LAND';
      (groups[mode === 'RIVER' ? 'SEA' : mode] ?? groups.LAND!).push(points);
    }
    for (const lane of lanes) {
      const points = simplify(cellsToPoints(lane.cells));
      this.routeLines.set(lane.id, points);
      groups.SEA!.push(points);
    }
    const style: Record<string, { color: string; width: number; opacity?: number }> = {
      LAND: { color: '#a07a48', width: 1.3 },
      BRIDGE: { color: '#6b4a2b', width: 1.5 },
      FORD: { color: '#c2ab7c', width: 1.3 },
      SEA: { color: '#d7e6ee', width: 0.9, opacity: 0.55 },
    };
    return Object.entries(groups).map(([mode, lines]) => {
      const { color, width, opacity } = style[mode]!;
      return new Mesh(
        this.ribbon(lines, width, mode === 'SEA' ? 0.2 : 0.35),
        new MeshStandardMaterial({
          color,
          roughness: 0.95,
          side: DoubleSide,
          ...(opacity ? { transparent: true, opacity } : {}),
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      );
    });
  }

  // 강: Natural Earth 강 선을 땅 위 물 띠로 그린다. 강 선은 통합 지도(1000×700) 좌표라
  // 경위도로 되돌린 뒤 이 판의 범위로 옮긴다(둘 다 등장방형 도법이라 1차 변환이다).
  private rivers(bounds: readonly number[]) {
    const [w0, s0, e0, n0] = riverBounds as [number, number, number, number];
    const [w1, s1, e1, n1] = bounds as [number, number, number, number];
    const { width, height } = this.canvasSize;
    const move = (point: { x: number; y: number }) => {
      const lon = w0 + (point.x / 1000) * (e0 - w0);
      const lat = n0 - (point.y / 700) * (n0 - s0);
      return { x: ((lon - w1) / (e1 - w1)) * width, y: ((n1 - lat) / (n1 - s1)) * height };
    };
    const lines = riverData.split(';').map((line) =>
      line.split(' ').map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return move({ x: x!, y: y! });
      }),
    );
    return new Mesh(
      this.ribbon(lines, 1.4, 0.15),
      new MeshStandardMaterial({
        color: '#3f7ba3',
        roughness: 0.25,
        metalness: 0.1,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
  }

  // 숲: 숲·구릉 칸에 낮은 다각형 나무를 흩뿌린다. 거점 자리 가까이는 비운다.
  private trees(map: PublicGeography, metres: Float32Array | null) {
    const clear = map.sites.map((site) => site.position);
    const spots = treeSpots(this.grid, this.canvasSize, metres).filter(
      (spot) => !clear.some((at) => Math.abs(at.x - spot.x) < 9 && Math.abs(at.y - spot.y) < 9),
    );
    const mesh = new InstancedMesh(
      new ConeGeometry(0.9, 2.6, 6).translate(0, 1.3, 0),
      new MeshStandardMaterial({ roughness: 0.9 }),
      spots.length,
    );
    const matrix = new Matrix4();
    const color = new Color();
    spots.forEach((spot, index) => {
      const base = this.world(spot.x, spot.y);
      matrix.makeScale(spot.scale, spot.scale, spot.scale).setPosition(base.x, base.y, base.z);
      mesh.setMatrixAt(index, matrix);
      const shade = cellNoise(index, 7);
      mesh.setColorAt(index, color.setRGB(0.16 + shade * 0.08, 0.3 + shade * 0.12, 0.14 + shade * 0.05));
    });
    return mesh;
  }

  // 거점 모형: 도시는 네모 성벽과 네 모서리 망루, 가운데 본전과 소유국 색 지붕. 관문은 성문 벽과 양쪽 망루.
  setSites(
    anchors: readonly AnchorSite[],
    cityByKey: ReadonlyMap<number, ModelCity>,
    nationById: ReadonlyMap<number, DrawnNation>,
  ) {
    for (const mesh of this.models) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    const parts = anchors.length * 4;
    const walls = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.85 }), parts);
    const towers = new InstancedMesh(
      new CylinderGeometry(0.5, 0.6, 1, 6),
      new MeshStandardMaterial({ roughness: 0.85 }),
      parts,
    );
    const keeps = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.8 }),
      anchors.length,
    );
    const roofs = new InstancedMesh(
      new ConeGeometry(0.75, 1, 4),
      new MeshStandardMaterial({ roughness: 0.6 }),
      anchors.length * 5,
    );
    const matrix = new Matrix4();
    const color = new Color();
    let w = 0;
    let t = 0;
    let r = 0;
    const roof = (x: number, y: number, z: number, side: number, height: number, tint: string) => {
      matrix
        .makeRotationY(Math.PI / 4)
        .scale(new Vector3(side, height, side))
        .setPosition(x, y + height / 2, z);
      roofs.setMatrixAt(r, matrix);
      roofs.setColorAt(r++, color.set(tint));
    };
    anchors.forEach((site, index) => {
      const city = cityByKey.get(site.anchorKey);
      const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
      const tint = nation?.color ?? NEUTRAL;
      const { side, height } = siteSize(site.kind, city?.level);
      const base = this.world(site.position.x, site.position.y);
      const half = side / 2;
      const thick = Math.max(side * 0.1, 0.6);
      const towerSize = thick * 2.2;
      const sides =
        site.kind === 'PASS'
          ? [{ dx: 0, dz: 0, sx: side * 1.6, sz: thick * 1.6 }]
          : [
              { dx: 0, dz: -half, sx: side, sz: thick },
              { dx: 0, dz: half, sx: side, sz: thick },
              { dx: -half, dz: 0, sx: thick, sz: side },
              { dx: half, dz: 0, sx: thick, sz: side },
            ];
      for (const wall of sides) {
        matrix.makeScale(wall.sx, height, wall.sz).setPosition(base.x + wall.dx, base.y + height / 2, base.z + wall.dz);
        walls.setMatrixAt(w, matrix);
        walls.setColorAt(w++, color.set(WALL));
      }
      const corners =
        site.kind === 'PASS'
          ? [
              [-side * 0.8, 0],
              [side * 0.8, 0],
            ]
          : [
              [-half, -half],
              [half, -half],
              [-half, half],
              [half, half],
            ];
      for (const [dx, dz] of corners) {
        const towerHeight = height * 1.5;
        matrix
          .makeScale(towerSize, towerHeight, towerSize)
          .setPosition(base.x + dx!, base.y + towerHeight / 2, base.z + dz!);
        towers.setMatrixAt(t, matrix);
        towers.setColorAt(t++, color.set(WALL));
        roof(base.x + dx!, base.y + towerHeight, base.z + dz!, towerSize * 1.5, towerSize * 0.9, tint);
      }
      const keepSide = site.kind === 'PASS' ? side * 0.5 : side * 0.45;
      const keepHeight = height * (site.kind === 'PASS' ? 1.2 : 1.7);
      matrix.makeScale(keepSide, keepHeight, keepSide).setPosition(base.x, base.y + keepHeight / 2, base.z);
      keeps.setMatrixAt(index, matrix);
      keeps.setColorAt(index, color.set('#e9dfc8'));
      roof(base.x, base.y + keepHeight, base.z, keepSide * 1.45, keepSide * 0.7, tint);
    });
    walls.count = w;
    towers.count = t;
    roofs.count = r;
    this.models = [walls, towers, keeps, roofs];
    for (const mesh of this.models) this.scene.add(mesh);
  }

  /**
   * 주둔 부대: 거점마다 장수 수만큼(많아야 6) 병사 대열과 소유국 색 깃발을 성 앞(남쪽)에 세운다.
   * 병력 수는 공개 자료가 아니라 장수 수로 대열 수를 정한다.
   */
  setArmies(entries: ReadonlyArray<{ site: AnchorSite; level: number | undefined; count: number; color: string }>) {
    for (const mesh of this.armies) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    const squads = entries.reduce((sum, entry) => sum + Math.min(entry.count, 6), 0);
    const bodies = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.8 }),
      squads * 4,
    );
    const flags = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.6 }), squads * 2);
    const matrix = new Matrix4();
    const color = new Color();
    let b = 0;
    let f = 0;
    for (const entry of entries) {
      const { side } = siteSize(entry.site.kind, entry.level);
      const count = Math.min(entry.count, 6);
      const body = color.set(entry.color).multiplyScalar(0.55).getHex();
      for (let i = 0; i < count; i++) {
        // 성 앞 반원에 대열을 늘어놓는다.
        const angle = Math.PI * (0.15 + (0.7 * (i + 0.5)) / count);
        const radius = side * 0.8 + 3;
        const x = entry.site.position.x + Math.cos(angle) * radius;
        const y = entry.site.position.y + Math.sin(angle) * radius;
        for (let k = 0; k < 4; k++) {
          const base = this.world(x + (k % 2) * 1.1 - 0.55, y + Math.floor(k / 2) * 1.1 - 0.55);
          matrix.makeScale(0.7, 1.1, 0.7).setPosition(base.x, base.y + 0.55, base.z);
          bodies.setMatrixAt(b, matrix);
          bodies.setColorAt(b++, color.setHex(body));
        }
        const pole = this.world(x - 0.9, y - 0.9);
        matrix.makeScale(0.15, 3.2, 0.15).setPosition(pole.x, pole.y + 1.6, pole.z);
        flags.setMatrixAt(f, matrix);
        flags.setColorAt(f++, color.set('#4a3a28'));
        matrix.makeScale(1.4, 0.9, 0.12).setPosition(pole.x + 0.7, pole.y + 2.7, pole.z);
        flags.setMatrixAt(f, matrix);
        flags.setColorAt(f++, color.set(entry.color));
      }
    }
    bodies.count = b;
    flags.count = f;
    this.armies = [bodies, flags];
    for (const mesh of this.armies) this.scene.add(mesh);
  }

  /** 행군 대열: 점 목록(지도 좌표)을 따라 병사 다섯과 깃발이 걷는다. null이면 지운다. */
  setMarch(points: Array<{ x: number; y: number }> | null, color: string) {
    if (this.march) {
      this.scene.remove(this.march.mesh, this.march.flags, this.march.trail);
      this.march.mesh.geometry.dispose();
      this.march.flags.geometry.dispose();
      this.march.trail.geometry.dispose();
      this.march = null;
    }
    if (!points || points.length < 2) return;
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.8 }), 6);
    const flags = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.6 }), 2);
    const tint = new Color(color);
    for (let i = 0; i < 6; i++) mesh.setColorAt(i, tint.clone().multiplyScalar(0.6));
    flags.setColorAt(0, new Color('#4a3a28'));
    flags.setColorAt(1, tint);
    // 지나갈 길을 주홍 띠로 강조한다(인자 입력 화면의 경로 줄과 같은 색).
    const trail = new Mesh(
      this.ribbon([points], 1.8, 0.5),
      new MeshBasicMaterial({ color: '#b23a2a', transparent: true, opacity: 0.85, side: DoubleSide }),
    );
    this.march = { points, mesh, flags, trail };
    this.scene.add(trail, mesh, flags);
    this.tick(0);
  }

  get marching() {
    return this.march !== null;
  }

  /** 행군 대열을 시각 now(ms)의 자리로 옮긴다. 경로 한 바퀴는 길이에 비례해 3~8초다. */
  tick(now: number) {
    const march = this.march;
    if (!march) return;
    const length = march.points.reduce(
      (sum, point, i) => (i ? sum + Math.hypot(point.x - march.points[i - 1]!.x, point.y - march.points[i - 1]!.y) : 0),
      0,
    );
    const period = Math.min(Math.max(length * 40, 3000), 8000);
    const t = (now % period) / period;
    const holder = new Object3D();
    for (let i = 0; i < 6; i++) {
      const at = along(march.points, Math.max(t - i * 0.02, 0));
      const base = this.world(at.x, at.y);
      holder.position.set(base.x, base.y + 1.1, base.z);
      holder.rotation.set(0, -at.angle, 0);
      holder.scale.set(1.6, 2.2, 1.6);
      holder.updateMatrix();
      march.mesh.setMatrixAt(i, holder.matrix);
    }
    march.mesh.instanceMatrix.needsUpdate = true;
    const head = along(march.points, t);
    const pole = this.world(head.x, head.y);
    holder.rotation.set(0, 0, 0);
    holder.position.set(pole.x, pole.y + 3.5, pole.z);
    holder.scale.set(0.3, 7, 0.3);
    holder.updateMatrix();
    march.flags.setMatrixAt(0, holder.matrix);
    holder.position.set(pole.x + 1.5, pole.y + 6.2, pole.z);
    holder.scale.set(3, 1.8, 0.2);
    holder.updateMatrix();
    march.flags.setMatrixAt(1, holder.matrix);
    march.flags.instanceMatrix.needsUpdate = true;
  }

  /** 고른 거점 둘레의 붉은 고리. null이면 지운다. */
  setSelected(site: AnchorSite | null, level: number | undefined) {
    if (this.ring) {
      this.scene.remove(this.ring);
      this.ring.geometry.dispose();
      this.ring = null;
    }
    if (!site) return;
    const { side } = siteSize(site.kind, level);
    const ring = new Mesh(
      new RingGeometry(side * 0.85, side * 0.85 + 2, 40),
      new MeshBasicMaterial({ color: '#b23a2a' }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(this.world(site.position.x, site.position.y, 0.3));
    this.ring = ring;
    this.scene.add(ring);
  }

  resize(width: number, height: number) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.renderer.setSize(this.width, this.height, false);
  }

  /** 카메라를 놓고 그린다. 정사영 카메라의 확대(zoom)는 화면 px당 지도 단위의 역수다. */
  render(state: CameraState) {
    const camera = this.camera;
    camera.left = -this.width / 2;
    camera.right = this.width / 2;
    camera.top = this.height / 2;
    camera.bottom = -this.height / 2;
    const distance = 1000;
    camera.position.set(state.x, Math.sin(ELEVATION) * distance, state.z + Math.cos(ELEVATION) * distance);
    camera.lookAt(state.x, 0, state.z);
    camera.zoom = state.zoom || 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.renderer.render(this.scene, camera);
  }

  /** 3D 위치의 화면 좌표(px). */
  project(point: Vector3) {
    const projected = point.clone().project(this.camera);
    return { x: ((projected.x + 1) / 2) * this.width, y: ((1 - projected.y) / 2) * this.height };
  }

  dispose() {
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}
