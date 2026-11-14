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
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { PublicGeography } from '@opensamguk/shared';
import type { Terrain } from '../main/terrainTiles';
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
  private width = 1;
  private height = 1;

  constructor(
    canvas: HTMLCanvasElement,
    {
      map,
      grid,
      heights,
      palette,
    }: { map: PublicGeography; grid: TerrainCells; heights: HeightData | null; palette: Record<Terrain, string> },
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
    this.scene.add(this.roads(map));
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

  // 길: 거점 사이를 땅 위로 조금 띄운 선으로 잇는다. 지형을 따라 잘게 나눈다.
  private roads(map: PublicGeography) {
    const byId = new Map(map.sites.map((site) => [site.id, site]));
    const points: number[] = [];
    for (const route of map.routes) {
      if (!route.enabled) continue;
      const path = [route.from, ...(route.via ?? []), route.to]
        .map((id) => byId.get(id))
        .filter((s) => s !== undefined);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!.position;
        const b = path[i]!.position;
        const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          const p0 = this.world(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, 0.4);
          const p1 = this.world(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, 0.4);
          points.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    return new LineSegments(geometry, new LineBasicMaterial({ color: '#7a5a34' }));
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
