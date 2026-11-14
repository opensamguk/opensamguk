// GLB 메시 하나 읽기 (INT-27 D-094). 거점 모형(Rodin을 블렌더로 줄인 GLB)만 읽는 작은 읽기기다.
// three의 GLTFLoader는 내장 그림 주소(data URI) 문자열을 담고 있어 공개 자산 검사(inline-image)에 걸린다.
// 여기서는 GLB 안의 이진 덩어리에서 기하와 그림을 바로 꺼낸다. 메시가 여럿이면 첫 메시의 첫 묶음만 쓴다.
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Matrix4,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';

type Gltf = {
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number }> }>;
  accessors: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
  materials?: Array<{
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
      baseColorFactor?: number[];
    };
    normalTexture?: { index: number };
    occlusionTexture?: { index: number };
  }>;
  textures?: Array<{ source?: number; extensions?: { EXT_texture_webp?: { source?: number } } }>;
  images?: Array<{ bufferView?: number; mimeType?: string }>;
};

const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS: Record<number, { new (buffer: ArrayBuffer, offset: number, length: number): ArrayLike<number> }> = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const BYTES: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

/** GLB 이진의 JSON·BIN 덩어리. */
export function parseGlb(buffer: ArrayBuffer): { json: Gltf; bin: ArrayBuffer } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('GLB 머리가 아닙니다');
  let offset = 12;
  let json: Gltf | null = null;
  let bin: ArrayBuffer | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length))) as Gltf;
    else if (type === 0x004e4942) bin = buffer.slice(start, start + length);
    offset = start + length;
  }
  if (!json || !bin) throw new Error('GLB 덩어리가 모자랍니다');
  return { json, bin };
}

function accessorArray(gltf: Gltf, bin: ArrayBuffer, index: number): { array: ArrayLike<number>; size: number } {
  const accessor = gltf.accessors[index]!;
  const size = SIZES[accessor.type] ?? 1;
  const view = gltf.bufferViews[accessor.bufferView ?? 0]!;
  const Kind = ARRAYS[accessor.componentType];
  if (!Kind) throw new Error('지원하지 않는 자료형');
  const bytes = BYTES[accessor.componentType]!;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 0;
  if (!stride || stride === size * bytes) return { array: new Kind(bin, start, accessor.count * size), size };
  // 띄엄띄엄 놓인 자료는 촘촘히 옮긴다.
  const out = new Float32Array(accessor.count * size);
  const data = new DataView(bin);
  for (let i = 0; i < accessor.count; i++)
    for (let k = 0; k < size; k++) {
      const at = start + i * stride + k * bytes;
      out[i * size + k] =
        accessor.componentType === 5126
          ? data.getFloat32(at, true)
          : accessor.componentType === 5125
            ? data.getUint32(at, true)
            : accessor.componentType === 5123
              ? data.getUint16(at, true)
              : data.getUint8(at);
    }
  return { array: out, size };
}

// 메시를 단 마디의 월드 행렬(부모 마디 변환을 모두 곱한 것).
function meshMatrix(gltf: Gltf): Matrix4 {
  const nodes = gltf.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((node, index) => node.children?.forEach((child) => parent.set(child, index)));
  const local = (index: number) => {
    const node = nodes[index]!;
    if (node.matrix) return new Matrix4().fromArray(node.matrix);
    return new Matrix4().compose(
      new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
      new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
      new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
    );
  };
  let at = nodes.findIndex((node) => node.mesh === 0);
  const matrix = new Matrix4();
  while (at >= 0) {
    matrix.premultiply(local(at));
    at = parent.get(at) ?? -1;
  }
  return matrix;
}

async function texture(gltf: Gltf, bin: ArrayBuffer, index: number | undefined, color: boolean) {
  if (index === undefined) return null;
  // 블렌더가 WebP로 내보내면 그림 번호가 EXT_texture_webp 확장 안에 들어간다.
  const entry = gltf.textures?.[index];
  const image = gltf.images?.[entry?.source ?? entry?.extensions?.EXT_texture_webp?.source ?? -1];
  if (!image || image.bufferView === undefined) return null;
  const view = gltf.bufferViews[image.bufferView]!;
  const blob = new Blob([new Uint8Array(bin, view.byteOffset ?? 0, view.byteLength)], {
    type: image.mimeType ?? 'image/png',
  });
  const bitmap = await createImageBitmap(blob);
  const map = new Texture(bitmap);
  map.flipY = false;
  if (color) map.colorSpace = SRGBColorSpace;
  map.needsUpdate = true;
  return map;
}

/**
 * 주소의 GLB에서 첫 메시를 읽어 기하(마디 변환 적용)와 재질을 만든다.
 * 금속 질감은 반사 환경이 없는 지도에서 검게 보이므로 금속은 끄고 거칠기만 쓴다.
 */
/** 카툰풍 명암 계단(사용자 2026-11-14: 아이콘처럼 카툰 풍). 빛을 네 단계로 끊는다. */
export function toonGradient(steps: readonly number[] = [90, 150, 215, 255]) {
  const texture = new DataTexture(Uint8Array.from(steps), steps.length, 1, RedFormat);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export async function loadGlbMesh(url: string): Promise<{ geometry: BufferGeometry; material: MeshToonMaterial }> {
  // 같은 주소로 모형을 다시 만들어 올릴 수 있어 매번 바뀌었는지 묻는다(바뀌지 않았으면 캐시를 쓴다).
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`모형을 받지 못했습니다 (${response.status})`);
  const { json, bin } = parseGlb(await response.arrayBuffer());
  const primitive = json.meshes[0]?.primitives[0];
  if (!primitive) throw new Error('메시가 없습니다');
  const geometry = new BufferGeometry();
  const names: Record<string, string> = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv' };
  for (const [key, name] of Object.entries(names)) {
    const index = primitive.attributes[key];
    if (index === undefined) continue;
    const { array, size } = accessorArray(json, bin, index);
    geometry.setAttribute(name, new BufferAttribute(Float32Array.from(array), size));
  }
  if (primitive.indices !== undefined) {
    const { array } = accessorArray(json, bin, primitive.indices);
    geometry.setIndex(new BufferAttribute(Uint32Array.from(array), 1));
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  geometry.applyMatrix4(meshMatrix(json));
  geometry.computeBoundingBox();
  const source = json.materials?.[primitive.material ?? 0];
  const [map, normalMap, roughnessMap, aoMap] = await Promise.all([
    texture(json, bin, source?.pbrMetallicRoughness?.baseColorTexture?.index, true),
    texture(json, bin, source?.normalTexture?.index, false),
    texture(json, bin, source?.pbrMetallicRoughness?.metallicRoughnessTexture?.index, false),
    texture(json, bin, source?.occlusionTexture?.index, false),
  ]);
  // 카툰풍: 금속·거칠기 대신 계단 명암으로 그린다(거칠기 그림은 쓰지 않는다).
  void roughnessMap;
  const material = new MeshToonMaterial({ map, normalMap, aoMap, gradientMap: toonGradient() });
  return { geometry, material };
}
