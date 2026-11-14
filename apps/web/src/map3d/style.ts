// 지도 화풍 규격 (INT-27, 사용자 2026-11-14: "제대로 된 셰이더 스타일을 만들어. 모든 게임에서 일정한.").
// 지형·물가·길·나무·거점 모형·다리·부대 표지가 모두 같은 빛과 같은 색 보정을 쓴다. 따로 노는 재질을 두지 않는다.
//
// 1. 빛 하나: 북서쪽 따뜻한 해(구운 그림 지도의 주광과 같은 방향) + 차가운 하늘빛 채움. 다른 광원은 없다.
// 2. 명암: 모든 빛 받는 면은 같은 부드러운 단계 명암(채색화식 계조, STYLE_RAMP)을 쓴다. 물리 기반 반사·금속감은 쓰지 않는다.
//    예외는 물 하나(수면의 해 반짝임)다.
// 3. 그늘: 검정으로 떨어지지 않는다. 해가 안 드는 면은 하늘빛 채움으로 바탕색의 약 45%가 남고 푸른 회색 기운을 띤다.
// 4. 윤곽: 거점 모형만 먹선(뒷면 부풀리기). 지형·길·물에는 선을 긋지 않는다.
// 5. 색 보정: 화면 전체에 한 번만 건다(GradePass). 1 아래는 그대로 두고 그 위만 부드럽게 눌러 그림 색이 바래지 않게 한다.
//    어두운 곳은 살짝 푸르게, 밝은 곳은 살짝 따뜻하게, 채도는 조금 올리고 가장자리를 아주 옅게 어둡게 한다.
// 6. 대기: 화면 위쪽(먼 곳)은 옅은 회청 안개(Fog, mapScene.render).
import {
  Color,
  DataTexture,
  HalfFloatType,
  Mesh,
  MeshToonMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type MeshToonMaterialParameters,
  type Texture,
  type WebGLRenderer,
} from 'three';

export const STYLE = {
  /** 해: 북서쪽, 고도 약 42°(월드 방향, 정규화 전). 구운 그림 지도의 주광(북서, 42°)과 맞춘다. */
  sunOffset: [-500, 525, -300] as const,
  sunColor: '#ffe7c4',
  /** 해의 세기. 단계 명암 최고점에서 바탕색의 약 62%가 더해진다(Lambert 1/π 포함). */
  sunIntensity: 1.95,
  skyColor: '#c9d6e2',
  groundColor: '#6b5a42',
  /** 하늘빛 채움 세기. 그늘에 바탕색의 약 45%가 남는다. */
  skyIntensity: 1.45,
  fogColor: '#cdd5d2',
  outline: '#2a1d12',
} as const;

/** 단계 명암(채색화식): 어두운 면부터 밝은 면까지 여섯 단계, 가운데를 넓게 둬 부드럽다. */
export const STYLE_RAMP = [36, 72, 120, 172, 222, 255] as const;

let ramp: DataTexture | null = null;
/** 모든 재질이 함께 쓰는 단계 명암 질감. */
export function styleRamp(): DataTexture {
  if (ramp) return ramp;
  ramp = new DataTexture(Uint8Array.from(STYLE_RAMP), STYLE_RAMP.length, 1, RedFormat);
  ramp.minFilter = NearestFilter;
  ramp.magFilter = NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

/**
 * 화풍 재질: 빛 받는 모든 면은 이것으로 만든다. 물리 기반 재질의 거칠기·금속값을 넘겨도 받아서 버린다
 * (예전 MeshStandardMaterial 호출부를 그대로 옮길 수 있게).
 */
export function styleMaterial(
  params: MeshToonMaterialParameters & { roughness?: number; metalness?: number; flatShading?: boolean } = {},
): MeshToonMaterial {
  const rest: MeshToonMaterialParameters & { roughness?: number; metalness?: number } = { ...params };
  delete rest.roughness;
  delete rest.metalness;
  return new MeshToonMaterial({ gradientMap: styleRamp(), ...rest });
}

const GRADE = `
uniform sampler2D tScene;
uniform vec2 uTexel;
varying vec2 vUv;
// 1 아래는 그대로, 위만 부드럽게 눌러 넘치는 빛만 다듬는다(그림 색이 바래지 않는다).
vec3 shoulder(vec3 c) {
  vec3 over = max(c - 0.82, 0.0);
  return min(c, 0.82) + 0.18 * (1.0 - exp(-over / 0.18));
}
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c = shoulder(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 채도 조금 올림.
  c = max(mix(vec3(l), c, 1.07), 0.0);
  // 어두운 곳은 푸른 회색, 밝은 곳은 따뜻하게(분할 색조).
  c += vec3(-0.010, 0.000, 0.016) * (1.0 - smoothstep(0.0, 0.35, l));
  c += vec3(0.014, 0.006, -0.012) * smoothstep(0.45, 1.0, l);
  // 아주 옅은 가장자리 어둡힘.
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * 0.22;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

/** 화면 전체 색 보정 한 번. 장면을 선형 HDR로 그린 뒤 이 패스로 화면에 낸다. */
export class GradePass {
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
  private readonly material = new ShaderMaterial({
    uniforms: { tScene: { value: this.target.texture as Texture }, uTexel: { value: new Vector2(1, 1) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: GRADE,
    toneMapped: false,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);
  private readonly scene = new Scene().add(this.quad);
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  setSize(width: number, height: number) {
    this.target.setSize(width, height);
    (this.material.uniforms.uTexel!.value as Vector2).set(1 / width, 1 / height);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

/** 화풍 색(sRGB 글자)을 three 색으로. */
export const styleColor = (hex: string) => new Color(hex);
