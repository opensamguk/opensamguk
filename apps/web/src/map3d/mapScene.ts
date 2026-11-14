// 3D 군략도 장면 (INT-27, D-089). three.js를 직접 써서 지형·숲·거점 모형·길·선택 고리를 그린다.
// react-three-fiber는 쓰지 않는다. 그 패키지 정보(외부 주소)가 번들에 들어가 공개 자산 검사에 걸리고,
// three 전체를 묶어 덩어리가 커진다. 필요한 부품만 가져온다.
import {
  AmbientLight,
  Box3,
  DataTexture,
  NearestFilter,
  SRGBColorSpace,
  Vector2,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  IcosahedronGeometry,
  CylinderGeometry,
  DoubleSide,
  ACESFilmicToneMapping,
  Fog,
  PCFShadowMap,
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
import { loadGlbMesh } from './glbMesh';
import { lodForPixels, pickModel, tileFill } from './siteModels';
import type { PublicGeography } from '@opensamguk/shared';
import { roadWalks, TERRAINS, waterLanes, type Terrain } from '../main/terrainTiles';
import { ROAD_CELL } from '../main/roadPixels';
import { bounds as riverBounds, lines as riverData } from './data/rivers';
import { along, cellsToPoints, simplify } from './routes3d';
import { fromTile, territoryTiles, toTile } from './territory3d';
import type { DrawnNation } from '../main/siteMarkers';
import type { ModelCity } from '../main/mapModel';
import {
  cellNoise,
  decodeDepth,
  decodeMetres,
  groundAt,
  heightField,
  heightFieldFromMetres,
  realisticColors,
  siteSize,
  treeSpots,
  UNITS_PER_METRE,
  type HeightData,
  type TerrainCells,
} from './terrain3d';

type Site = PublicGeography['sites'][number];
export type AnchorSite = Site & { anchorKey: number };

// 위에서 내려다보는 각도(수평에서 55°). 화면 위쪽이 북쪽이다.
export const ELEVATION = (45 * Math.PI) / 180;
/** 영지 칸 한 변(지도 단위). 칸은 45° 돌려 놓아 비스듬히 보면 마름모다. */
export const TILE = 8;
const NEUTRAL = '#d6d0c4';
const LAKE = TERRAINS.indexOf('lake');

// 영지 칸 그리기. 월드 xz를 45° 돌린 칸 좌표로 바꿔 칸 자료를 읽고,
// - 가는 칸 격자(멀리서는 흐린다)와 소유국 색 옅은 칠,
// - 이웃 칸과 도시가 다르면 금빛 도시 경계, 나라가 다르면 굵은 나라색 국경을 긋는다.
const TERRITORY_GLSL = `
vec4 tileAt(vec2 cell) {
  vec2 uv = (cell - uTileOrigin + 0.5) / uTileCount;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTerritory, uv);
}
bool hasNation(vec4 tile) { return tile.a > 0.0 && dot(tile.rgb, vec3(1.0)) > 0.0; }
vec3 territoryColor(vec3 base, vec2 xz) {
  vec2 q = vec2(xz.x + xz.y, xz.y - xz.x) * ${Math.SQRT1_2} / ${TILE.toFixed(1)};
  vec2 cell = floor(q);
  vec2 f = fract(q);
  vec2 fw = fwidth(q);
  float pxTile = max(fw.x, fw.y);
  vec4 own = tileAt(cell);
  vec3 color = base;
  // 멀리서 볼수록 나라 색을 진하게 칠해 천하 판도가 한눈에 읽힌다. 가까이서는 지형이 보이게 옅게.
  float far = smoothstep(0.04, 0.22, pxTile);
  if (hasNation(own)) color = mix(color, own.rgb, mix(0.16, 0.42, far));
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  float grid = (1.0 - smoothstep(0.0, pxTile * 1.1, edge)) * (1.0 - smoothstep(0.05, 0.12, pxTile));
  color = mix(color, vec3(1.0, 0.97, 0.86), grid * (own.a > 0.0 ? 0.16 : 0.08));
  vec4 sides[4];
  sides[0] = tileAt(cell + vec2(-1.0, 0.0));
  sides[1] = tileAt(cell + vec2(1.0, 0.0));
  sides[2] = tileAt(cell + vec2(0.0, -1.0));
  sides[3] = tileAt(cell + vec2(0.0, 1.0));
  float dist[4];
  dist[0] = f.x;
  dist[1] = 1.0 - f.x;
  dist[2] = f.y;
  dist[3] = 1.0 - f.y;
  for (int k = 0; k < 4; k++) {
    vec4 other = sides[k];
    if (own.a == 0.0 && other.a == 0.0) continue;
    bool nation = distance(own.rgb, other.rgb) > 0.01 || ((own.a > 0.0) != (other.a > 0.0));
    bool city = abs(own.a - other.a) > 0.001;
    if (!nation && !city) continue;
    // 주인 없는 땅끼리의 도시 경계는 긋지 않는다(빈 땅이 금줄로 어지럽지 않게).
    if (!nation && !hasNation(own) && !hasNation(other)) continue;
    float width = nation ? 2.6 : 1.3;
    float line = 1.0 - smoothstep(pxTile * width * 0.5, pxTile * (width * 0.5 + 1.0), dist[k]);
    vec3 ink = vec3(0.93, 0.8, 0.5);
    if (nation) ink = hasNation(own) ? own.rgb : hasNation(other) ? other.rgb : ink;
    color = mix(color, ink, line * (nation ? 0.95 : mix(0.7, 0.35, far)));
  }
  return color;
}`;

const WALL = '#cbbd9e';

// 지형·물 셰이더가 함께 쓰는 잡음. hash2·noise2·fbm은 부드러운 얼룩, ridged는 산 능선처럼 날 선 기복이다.
const TERRAIN_NOISE = `
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int k = 0; k < 4; k++) { v += a * noise2(p); p *= 2.03; a *= 0.5; } return v; }
float ridged(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int k = 0; k < 4; k++) { float n = 1.0 - abs(noise2(p) * 2.0 - 1.0); v += a * n * n; p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return v;
}`;

export type CameraState = { x: number; z: number; zoom: number };

export class MapScene {
  readonly renderer: WebGLRenderer;
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -4000, 4000);
  private readonly scene = new Scene();
  private readonly canvasSize: { width: number; height: number };
  private readonly field: Float32Array;
  private readonly grid: TerrainCells;
  private models: Mesh[] = [];
  /** 받아 둔 GLB 거점 모형(이름 → 거리 단계별 기하·재질). 개발 미리보기(?models=)와 승인 모형이 채운다. */
  private modelSet = new Map<string, Array<{ geometry: BufferGeometry; material: Mesh['material']; box: Box3 }>>();
  private siteModelMeshes: Array<{ lod: number; mesh: InstancedMesh }> = [];
  private lastSites: {
    anchors: readonly AnchorSite[];
    cityByKey: ReadonlyMap<number, ModelCity>;
  } | null = null;
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
  private readonly sun = new DirectionalLight('#fff0d6', 3.4);
  /** 물결 셰이더의 시각(초). 그릴 때마다 옮긴다. */
  private readonly waterTime = { value: 0 };
  /** 영지 칸 자료(셰이더): 칸마다 소유국 색(RGB)과 도시 번호(A). setSites가 채운다. */
  private readonly territory = {
    map: { value: new DataTexture(new Uint8Array(4), 1, 1) },
    origin: { value: new Vector2() },
    count: { value: new Vector2(1, 1) },
  };
  private rings: Mesh[] = [];

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
    // 영화식 색조 보정과 부드러운 그림자. 저사양(좁은 화면)은 그림자 해상도를 줄인다.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.canvasSize = map.canvas;
    this.grid = grid;
    const metres = heights ? decodeMetres(heights) : null;
    const depth = heights ? decodeDepth(heights, grid.columns, grid.rows) : null;
    this.field = metres ? heightFieldFromMetres(grid, metres, depth) : heightField(grid);

    // 하늘빛(위)과 땅에서 되비치는 흙빛(아래). 해가 낮아 능선의 명암이 또렷하다.
    this.scene.add(new HemisphereLight('#dfe8ee', '#6a5a40', 0.5));
    this.scene.add(new AmbientLight('#ffffff', 0.08));
    // 해는 북서쪽 낮은 각도. 그림자 카메라는 보이는 범위를 따라 옮긴다(render).
    const sun = this.sun;
    sun.castShadow = true;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.4;
    this.scene.add(sun, sun.target);
    // 대기 원근감: 화면 위쪽(먼 북쪽)이 엷게 흐려진다.
    this.scene.fog = new Fog('#c3cfd8', 1150, 2100);

    this.scene.add(this.terrain(palette, metres));
    // 지도 밖까지 이어지는 먼바다. 가장 깊은 바닥보다 아래에 둬 지도 안의 물·바닥을 가리지 않는다.
    const ocean = new Mesh(
      new PlaneGeometry(map.canvas.width * 1.6, map.canvas.height * 1.6),
      new MeshStandardMaterial({ color: '#0c2a42', roughness: 0.35 }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -9;
    this.scene.add(ocean, this.water(depth));
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
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    // 질감 그림(D-090)이 오기 전까지 셰이더로 사실감을 낸다. 모두 월드 좌표 잡음이라 칸 경계가 드러나지 않는다.
    // - 산: 능선 잡음으로 낸 잔 기복(법선)과, 경사면 바위·고도 눈을 화소마다 다시 칠한다.
    // - 바닷가: 물높이 바로 위는 모래, 물 아래는 바닥 흙. 해안선이 칸이 아니라 높이 0 선을 따른다.
    // - 평야: 가까이 볼 때만 논밭 조각보 무늬(멀리서는 흐려 물결무늬가 생기지 않게).
    const territory = this.territory;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTerritory = territory.map;
      shader.uniforms.uTileOrigin = territory.origin;
      shader.uniforms.uTileCount = territory.count;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGround;\nvarying vec3 vUp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvGround = position;\nvUp = normal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec3 vGround;\nvarying vec3 vUp;\nuniform sampler2D uTerritory;\nuniform vec2 uTileOrigin;\nuniform vec2 uTileCount;\n${TERRAIN_NOISE}\n${TERRITORY_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
// 그림체(사용자 참고 시안 2026-11-14): 잔결 대신 큰 붓자국 얼룩, 고르고 따뜻한 색, 구름 그림자, 짙은 나무 점.
float grain = fbm(vGround.xz * 0.12) * 0.7 + fbm(vGround.xz * 0.9) * 0.3;
float brush = fbm(vec2(vGround.x * 0.55 + vGround.z * 0.2, vGround.z * 0.07 - vGround.x * 0.03));
float px = fwidth(vGround.x) + fwidth(vGround.z);
float flatness = clamp(vUp.y, 0.0, 1.0);
vec3 paint = diffuseColor.rgb;
float luma = dot(paint, vec3(0.3, 0.55, 0.15));
paint = mix(vec3(luma), paint, 0.82) * vec3(1.05, 1.0, 0.88);
paint *= 0.93 + grain * 0.14 + (brush - 0.5) * 0.08;
float cloud = smoothstep(0.56, 0.78, fbm(vGround.xz * 0.011 + vec2(3.1, 7.7)));
paint *= 1.0 - cloud * 0.2;
float lush = smoothstep(-0.02, 0.06, paint.g - paint.r);
float lowland = (1.0 - smoothstep(2.0, 9.0, vGround.y)) * step(0.25, vGround.y) * smoothstep(0.9, 0.97, flatness);
vec2 tq = vGround.xz * 1.25;
vec2 tc = floor(tq);
vec2 tj = vec2(hash2(tc + 3.7), hash2(tc + 9.1)) - 0.5;
float tdot = length(fract(tq) - 0.5 - tj * 0.5);
float tdensity = smoothstep(0.42, 0.72, fbm(vGround.xz * 0.045 + 11.0)) * lowland * (0.4 + lush * 0.6);
float tree = step(hash2(tc), tdensity * 0.7) * (1.0 - smoothstep(0.1, 0.19, tdot)) * (1.0 - smoothstep(0.18, 0.45, px));
paint = mix(paint, vec3(0.15, 0.23, 0.11), tree * 0.85);
diffuseColor.rgb = paint;
// 바닷가 모래와 물 아래 바닥.
float sand = (1.0 - smoothstep(0.08, 0.45, vGround.y + (grain - 0.5) * 0.2)) * step(-0.02, vGround.y) * smoothstep(0.9, 0.97, flatness);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.74, 0.58) * (0.9 + grain * 0.2), sand * 0.75);
if (vGround.y < -0.02) diffuseColor.rgb = mix(vec3(0.62, 0.58, 0.46), vec3(0.30, 0.33, 0.30), smoothstep(-0.05, -2.0, vGround.y)) * (0.85 + grain * 0.3);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
// 잔 기복: 능선 잡음의 기울기로 법선을 흔든다. 높고 가파를수록 세게, 평야는 거의 그대로.
// 산세는 크게: 낮은 주파수 능선만 쓰고 평야는 거의 건드리지 않는다(그림체에서 자글자글함을 뺀다).
float rugged = smoothstep(1.5, 10.0, vGround.y) * 0.8 + smoothstep(0.99, 0.9, vUp.y) * 0.3;
rugged *= 1.0 - smoothstep(0.35, 0.9, px);
vec2 g = vec2(0.0);
if (rugged > 0.01) {
  float e = 0.2;
  float h0 = ridged(vGround.xz * 0.09);
  g = vec2(ridged((vGround.xz + vec2(e, 0.0)) * 0.09) - h0, ridged((vGround.xz + vec2(0.0, e)) * 0.09) - h0) / e;
  g *= rugged * 1.6;
  normal = normalize(normal + (viewMatrix * vec4(-g.x, 0.0, -g.y, 0.0)).xyz);
}
// 바위·눈은 흔든 법선의 경사와 고도로 화소마다 정한다.
float slope = 1.0 - normalize(vUp + vec3(-g.x, 0.0, -g.y) * 0.6).y;
float rock = smoothstep(0.16, 0.42, slope + (grain - 0.5) * 0.12) * step(0.3, vGround.y);
vec3 rockColor = mix(vec3(0.42, 0.39, 0.35), vec3(0.55, 0.5, 0.44), grain);
diffuseColor.rgb = mix(diffuseColor.rgb, rockColor, rock * 0.85);
float snow = smoothstep(${(4300 * UNITS_PER_METRE).toFixed(2)}, ${(5200 * UNITS_PER_METRE).toFixed(2)}, vGround.y + (grain - 0.5) * ${(650 * UNITS_PER_METRE).toFixed(2)}) * (1.0 - smoothstep(0.45, 0.75, slope));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.94, 0.96), snow);
if (vGround.y > 0.0) diffuseColor.rgb = territoryColor(diffuseColor.rgb, vGround.xz);
// 오지(무대 밖 땅): 색을 빼고 어둡게 해 게임 무대 밖임을 보인다.
if (vGround.y > 0.05 && tileAt(floor(vec2(vGround.x + vGround.z, vGround.z - vGround.x) * ${Math.SQRT1_2} / ${TILE.toFixed(1)})).a == 0.0) {
  float grey = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(grey) * 0.72, 0.65);
}`,
        );
    };
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  // 물: 지형 판과 같은 칸의 수면. 꼭짓점마다 물 깊이(m)를 실어 얕은 대륙붕은 청록, 먼바다는 짙은 남색으로,
  // 바닷가는 맑고 흰 물거품이 인다. 물결은 잡음 기울기로 법선을 흔들어 햇빛 반짝임을 낸다.
  private water(depth: Float32Array | null) {
    const { width, height } = this.canvasSize;
    const geometry = new PlaneGeometry(width, height, this.grid.columns - 1, this.grid.rows - 1);
    geometry.rotateX(-Math.PI / 2);
    const metres = new Float32Array(this.field.length);
    for (let i = 0; i < metres.length; i++) {
      const below = Math.max(-this.field[i]!, 0) / UNITS_PER_METRE / 2.5;
      metres[i] = this.field[i]! > 0 ? 0 : Math.max(depth?.[i] ?? 0, below);
    }
    geometry.setAttribute('aDepth', new Float32BufferAttribute(metres, 1));
    const material = new MeshStandardMaterial({ roughness: 0.3, metalness: 0, transparent: true });
    const time = this.waterTime;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec2 vSea;`,
        )
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDepth = aDepth;\nvSea = position.xz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform float uTime;\nvarying float vDepth;\nvarying vec2 vSea;\n${TERRAIN_NOISE}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float d = sqrt(max(vDepth, 0.0) / 3000.0);
vec3 water = mix(vec3(0.13, 0.42, 0.44), vec3(0.06, 0.25, 0.37), smoothstep(0.02, 0.2, d));
water = mix(water, vec3(0.03, 0.12, 0.24), smoothstep(0.2, 0.7, d));
float foamNoise = fbm(vSea * 1.6 + vec2(uTime * 0.05, 0.0));
float foam = (1.0 - smoothstep(0.0, 4.0, vDepth)) * smoothstep(0.45, 0.7, foamNoise);
diffuseColor.rgb = mix(water, vec3(0.92, 0.95, 0.95), foam * 0.7);
diffuseColor.a = mix(0.45, 0.97, smoothstep(0.0, 30.0, vDepth));`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
vec2 w = vSea * 0.9 + vec2(uTime * 0.08, uTime * 0.05);
float e2 = 0.1;
float w0 = fbm(w);
vec2 wg = vec2(fbm(w + vec2(e2, 0.0)) - w0, fbm(w + vec2(0.0, e2)) - w0) / e2 * 0.06;
normal = normalize(normal + (viewMatrix * vec4(-wg.x, 0.0, -wg.y, 0.0)).xyz);`,
        );
    };
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
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
      LAND: { color: '#8f7350', width: 0.8, opacity: 0.55 },
      BRIDGE: { color: '#6b4a2b', width: 1.1, opacity: 0.8 },
      FORD: { color: '#b9a57a', width: 0.8, opacity: 0.55 },
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
    // 강둑(옅은 풀빛 모래)을 넓게 깔고 그 위에 청록 물 띠를 얹는다.
    const group = new Object3D();
    group.add(
      new Mesh(
        this.ribbon(lines, 3.2, 0.1),
        new MeshStandardMaterial({
          color: '#c3cc98',
          roughness: 0.9,
          side: DoubleSide,
          transparent: true,
          opacity: 0.4,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      ),
    );
    const water = new Mesh(
      this.ribbon(lines, 2.4, 0.16),
      new MeshStandardMaterial({
        color: '#3f9ea3',
        roughness: 0.2,
        metalness: 0,
        transparent: true,
        opacity: 0.92,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    group.add(water);
    return group;
  }

  // 숲: 숲·구릉 칸에 나무를 촘촘히 흩뿌린다. 높은 곳·북쪽은 바늘잎나무(뾰족), 낮은 남쪽은 넓은잎나무(둥근 수관)다.
  // 거점 자리 가까이는 비운다. 나무마다 크기·기울기·잎빛을 조금씩 달리해 같은 모양이 줄지어 보이지 않게 한다.
  private trees(map: PublicGeography, metres: Float32Array | null) {
    const clear = map.sites.map((site) => site.position);
    const spots = treeSpots(this.grid, this.canvasSize, metres).filter(
      (spot) => !clear.some((at) => Math.abs(at.x - spot.x) < 9 && Math.abs(at.y - spot.y) < 9),
    );
    const { columns, rows } = this.grid;
    const conifer = (spot: { x: number; y: number }, index: number) => {
      const column = Math.min(Math.floor((spot.x / this.canvasSize.width) * columns), columns - 1);
      const row = Math.min(Math.floor((spot.y / this.canvasSize.height) * rows), rows - 1);
      const height = metres?.[row * columns + column] ?? 0;
      const north = 1 - row / rows;
      return height > 1400 || cellNoise(index, 41) < north * 0.7 - 0.1;
    };
    const kinds = spots.map((spot, index) => conifer(spot, index));
    const needles = new InstancedMesh(
      new ConeGeometry(0.75, 2.8, 7).translate(0, 1.5, 0),
      new MeshStandardMaterial({ roughness: 0.9 }),
      kinds.filter(Boolean).length,
    );
    const leaves = new InstancedMesh(
      new IcosahedronGeometry(1, 0).scale(1, 0.85, 1).translate(0, 1.25, 0),
      new MeshStandardMaterial({ roughness: 0.85, flatShading: true }),
      kinds.length - kinds.filter(Boolean).length,
    );
    const holder = new Object3D();
    const color = new Color();
    let n = 0;
    let l = 0;
    spots.forEach((spot, index) => {
      const base = this.world(spot.x, spot.y);
      const scale = spot.scale * 0.72;
      holder.position.set(base.x, base.y - 0.1, base.z);
      holder.rotation.set((cellNoise(index, 51) - 0.5) * 0.12, cellNoise(index, 52) * Math.PI * 2, 0);
      holder.scale.set(scale, scale * (0.85 + cellNoise(index, 53) * 0.35), scale);
      holder.updateMatrix();
      const shade = cellNoise(index, 7);
      if (kinds[index]) {
        needles.setMatrixAt(n, holder.matrix);
        needles.setColorAt(n++, color.setRGB(0.1 + shade * 0.05, 0.2 + shade * 0.07, 0.13 + shade * 0.04));
      } else {
        leaves.setMatrixAt(l, holder.matrix);
        leaves.setColorAt(l++, color.setRGB(0.17 + shade * 0.1, 0.3 + shade * 0.12, 0.12 + shade * 0.05));
      }
    });
    const group = new Object3D();
    for (const mesh of [needles, leaves]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  // 거점 모형: 도시는 네모 성벽과 네 모서리 망루, 가운데 본전과 소유국 색 지붕. 관문은 성문 벽과 양쪽 망루.
  setSites(
    anchors: readonly AnchorSite[],
    cityByKey: ReadonlyMap<number, ModelCity>,
    nationById: ReadonlyMap<number, DrawnNation>,
  ) {
    for (const mesh of [...this.models, ...this.rings]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.setTerritory(anchors, cityByKey, nationById);
    const parts = anchors.length * 4;
    // 성 받침: 성벽보다 조금 넓은 흙 단. 모형이 비탈에 묻히지 않고 놓인 것처럼 보인다.
    const plinths = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: '#8f7a58', roughness: 0.95 }),
      anchors.length,
    );
    // 영지 고리: 모든 도시 둘레에 소유국 색 고리(주인 없으면 옅은 회색). 고른 거점의 붉은 고리는 따로 둔다.
    const rings = new InstancedMesh(
      new RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
      anchors.length,
    );
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
      const pad = site.kind === 'PASS' ? side * 1.9 : side * 1.35;
      matrix.makeScale(pad, 1.2, site.kind === 'PASS' ? side * 0.7 : pad).setPosition(base.x, base.y - 0.3, base.z);
      plinths.setMatrixAt(index, matrix);
      const ringSize = side * (site.kind === 'PASS' ? 1.25 : 1.15);
      matrix.makeScale(ringSize, 1, ringSize).setPosition(base.x, base.y + 0.35, base.z);
      rings.setMatrixAt(index, matrix);
      rings.setColorAt(index, color.set(nation?.color ?? '#9d968a'));
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
    this.models = [plinths, walls, towers, keeps, roofs];
    for (const mesh of this.models) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    this.rings = [rings];
    this.scene.add(rings);
    this.lastSites = { anchors, cityByKey };
    this.placeSiteModels();
  }

  /**
   * GLB 거점 모형을 받는다. 파일은 `<base>/<이름>-lod<0|1|2>.glb`이고 없는 이름은 건너뛴다.
   * 모형마다 메시 하나(Rodin 결과)를 기대하며, 여럿이면 첫 메시를 쓴다.
   */
  async loadSiteModels(base: string, names: readonly string[]) {
    await Promise.all(
      names.map(async (name) => {
        try {
          const lods = await Promise.all(
            [0, 1, 2].map(async (lod) => {
              const { geometry, material } = await loadGlbMesh(`${base}/${name}-lod${lod}.glb`);
              return { geometry, material, box: geometry.boundingBox!.clone() };
            }),
          );
          this.modelSet.set(name, lods);
        } catch {
          // 없는 모형은 건너뛴다(다음 후보나 임시 상자 모형을 쓴다).
        }
      }),
    );
    this.placeSiteModels();
  }

  // 받은 모형을 거점마다 세운다. 같은 모형·같은 거리 단계는 하나의 복제 묶음(InstancedMesh)으로 그린다.
  // 모형이 선 거점이 있으면 임시 상자 모형은 감춘다(고리는 둔다).
  private placeSiteModels() {
    for (const { mesh } of this.siteModelMeshes) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.siteModelMeshes = [];
    if (!this.lastSites || this.modelSet.size === 0) return;
    const available = new Set(this.modelSet.keys());
    const groups = new Map<string, AnchorSite[]>();
    for (const site of this.lastSites.anchors) {
      const level = this.lastSites.cityByKey.get(site.anchorKey)?.level;
      const name = pickModel(site.kind, level, available);
      if (!name) continue;
      const list = groups.get(name) ?? [];
      list.push(site);
      groups.set(name, list);
    }
    const matrix = new Matrix4();
    const scaleMatrix = new Matrix4();
    const moveMatrix = new Matrix4();
    const turn = new Matrix4().makeRotationY(Math.PI / 4);
    for (const [name, sites] of groups) {
      const lods = this.modelSet.get(name)!;
      lods.forEach(({ geometry, material, box }, lod) => {
        const mesh = new InstancedMesh(geometry, material, sites.length);
        const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) || 1;
        sites.forEach((site, index) => {
          const level = this.lastSites!.cityByKey.get(site.anchorKey)?.level;
          // 모형은 영지 칸 한 칸 안에 든다. 거점이 놓인 칸의 가운데에 세우고 단계별 비율로 칸을 채운다.
          const footprint = TILE * tileFill(site.kind, level);
          // 발자국에 맞추되 키는 발자국을 넘지 않게 묶는다(관문 바위처럼 높은 모형이 탑처럼 솟지 않게).
          const height = box.max.y - box.min.y || 1;
          const scale = Math.min(footprint / width, (footprint * 0.55) / height);
          const centre = this.tileCentre(site.position.x, site.position.y);
          const base = this.world(centre.x, centre.y);
          const cx = (box.min.x + box.max.x) / 2;
          const cz = (box.min.z + box.max.z) / 2;
          // 가운데를 원점에 두고 키우고, 45° 돌려 성벽이 마름모 영지 칸과 나란하게 한 뒤 거점 자리로 옮긴다.
          matrix
            .makeTranslation(-cx, -box.min.y, -cz)
            .premultiply(scaleMatrix.makeScale(scale, scale, scale))
            .premultiply(turn)
            .premultiply(moveMatrix.makeTranslation(base.x, base.y - 0.25, base.z));
          mesh.setMatrixAt(index, matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.visible = lod === 2;
        this.scene.add(mesh);
        this.siteModelMeshes.push({ lod, mesh });
      });
    }
    // 영지 고리도 모형 크기·칸 가운데에 맞춘다.
    const ringMesh = this.rings[0] as InstancedMesh | undefined;
    if (ringMesh) {
      const placed = new Set([...groups.values()].flat().map((site) => site.id));
      this.lastSites.anchors.forEach((site, index) => {
        if (!placed.has(site.id)) return;
        const level = this.lastSites!.cityByKey.get(site.anchorKey)?.level;
        const centre = this.tileCentre(site.position.x, site.position.y);
        const base = this.world(centre.x, centre.y);
        const radius = TILE * tileFill(site.kind, level) * 0.78;
        matrix.makeScale(radius, 1, radius).setPosition(base.x, base.y + 0.35, base.z);
        ringMesh.setMatrixAt(index, matrix);
      });
      ringMesh.instanceMatrix.needsUpdate = true;
    }
    const covered = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
    const allCovered = covered === this.lastSites.anchors.length;
    for (const mesh of this.models) mesh.visible = !allCovered;
  }

  // 영지 칸 자료를 셰이더 질감으로 올린다. 도시만 영지를 갖고, 관문·항구·전장은 갖지 않는다.
  private setTerritory(
    anchors: readonly AnchorSite[],
    cityByKey: ReadonlyMap<number, ModelCity>,
    nationById: ReadonlyMap<number, DrawnNation>,
  ) {
    const cities = anchors
      .filter((site) => site.kind === 'CITY')
      .map((site) => {
        const city = cityByKey.get(site.anchorKey);
        const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
        return {
          key: site.anchorKey,
          x: site.position.x,
          y: site.position.y,
          level: city?.level ?? 3,
          color: nation?.color ?? null,
        };
      });
    const tiles = territoryTiles(
      cities,
      this.canvasSize,
      TILE,
      (x, y) => groundAt(this.field, this.grid, this.canvasSize, x, y) > 0 && this.rawGround(x, y) > 0.05,
      (x, y) => this.cellAt(x, y) === LAKE,
    );
    const texture = new DataTexture(tiles.data, tiles.columns, tiles.rows);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    this.territory.map.value.dispose();
    this.territory.map.value = texture;
    this.territory.origin.value.set(tiles.originX, tiles.originY);
    this.territory.count.value.set(tiles.columns, tiles.rows);
  }

  /** 지도 좌표가 놓인 지형 칸 종류 번호. */
  private cellAt(x: number, y: number) {
    const column = Math.min(
      Math.max(Math.floor((x / this.canvasSize.width) * this.grid.columns), 0),
      this.grid.columns - 1,
    );
    const row = Math.min(Math.max(Math.floor((y / this.canvasSize.height) * this.grid.rows), 0), this.grid.rows - 1);
    return this.grid.cells[row * this.grid.columns + column]!;
  }

  /** 지도 좌표가 든 영지 칸의 가운데(지도 좌표). */
  private tileCentre(x: number, y: number) {
    const { u, v } = toTile(x, y, this.canvasSize, TILE);
    return fromTile(Math.floor(u) + 0.5, Math.floor(v) + 0.5, this.canvasSize, TILE);
  }

  /** 물높이로 자르지 않은 땅 높이(가장 가까운 칸). 바다 칸을 가려낼 때 쓴다. */
  private rawGround(x: number, y: number) {
    const column = Math.min(
      Math.max(Math.round((x / this.canvasSize.width) * (this.grid.columns - 1)), 0),
      this.grid.columns - 1,
    );
    const row = Math.min(
      Math.max(Math.round((y / this.canvasSize.height) * (this.grid.rows - 1)), 0),
      this.grid.rows - 1,
    );
    return this.field[row * this.grid.columns + column]!;
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
    for (const mesh of this.armies) {
      mesh.castShadow = true;
      this.scene.add(mesh);
    }
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
    // 그림자 범위는 보이는 지도만큼. 멀리서 볼 때는 그림자 해상도가 모자라 그림자를 끈다.
    const span = Math.max(this.width, this.height) / (state.zoom || 1);
    this.sun.castShadow = span < 420;
    if (this.sun.castShadow) {
      const shadow = this.sun.shadow.camera;
      shadow.left = -span * 0.75;
      shadow.right = span * 0.75;
      shadow.top = span * 0.75;
      shadow.bottom = -span * 0.75;
      shadow.near = 1;
      shadow.far = 2000;
      shadow.updateProjectionMatrix();
      this.sun.target.position.set(state.x, 0, state.z);
      this.sun.position.set(state.x - 500, 380, state.z - 300);
    }
    // 거점 모형 거리 단계: 특 도시 한 변(약 16단위)이 화면에서 몇 px인지로 정한다.
    if (this.siteModelMeshes.length) {
      const lod = lodForPixels(16 * (state.zoom || 1));
      for (const entry of this.siteModelMeshes) entry.mesh.visible = entry.lod === lod;
    }
    this.waterTime.value = performance.now() / 1000;
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
