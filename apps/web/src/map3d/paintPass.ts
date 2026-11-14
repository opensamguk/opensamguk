// 그림 후처리 (INT-27, 사용자 2026-11-14: 그림으로 그린 것 같게). 3D 장면을 한 번 그린 뒤
// 쿠와하라(Kuwahara) 필터로 붓 터치처럼 색을 뭉친다. 네 사분면 가운데 색이 가장 고른 쪽의 평균을 쓴다.
// 덧붙여 밝기 경계에 옅은 먹선을 얹어 손으로 그린 윤곽 느낌을 낸다.
import {
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three';

const FRAGMENT = `
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform float uInk;
varying vec2 vUv;
const int R = 3;
void quadrant(vec2 start, out vec3 mean, out float spread) {
  vec3 sum = vec3(0.0);
  vec3 sq = vec3(0.0);
  for (int j = 0; j <= R; j++)
    for (int i = 0; i <= R; i++) {
      vec3 c = texture2D(tScene, vUv + (start + vec2(float(i), float(j))) * uTexel).rgb;
      sum += c;
      sq += c * c;
    }
  float n = float((R + 1) * (R + 1));
  mean = sum / n;
  vec3 v = abs(sq / n - mean * mean);
  spread = v.r + v.g + v.b;
}
void main() {
  vec3 m0; vec3 m1; vec3 m2; vec3 m3;
  float s0; float s1; float s2; float s3;
  float r = float(R);
  quadrant(vec2(-r, -r), m0, s0);
  quadrant(vec2(0.0, -r), m1, s1);
  quadrant(vec2(-r, 0.0), m2, s2);
  quadrant(vec2(0.0, 0.0), m3, s3);
  vec3 colour = m0;
  float best = s0;
  if (s1 < best) { best = s1; colour = m1; }
  if (s2 < best) { best = s2; colour = m2; }
  if (s3 < best) { best = s3; colour = m3; }
  // 먹선: 밝기 기울기가 큰 곳을 조금 어둡게.
  float l = dot(texture2D(tScene, vUv).rgb, vec3(0.3, 0.55, 0.15));
  float lx = dot(texture2D(tScene, vUv + vec2(uTexel.x * 1.5, 0.0)).rgb, vec3(0.3, 0.55, 0.15));
  float ly = dot(texture2D(tScene, vUv + vec2(0.0, uTexel.y * 1.5)).rgb, vec3(0.3, 0.55, 0.15));
  float edge = smoothstep(0.04, 0.16, abs(lx - l) + abs(ly - l));
  colour *= 1.0 - edge * uInk;
  // 필터가 색을 평균내며 흐려진 만큼 채도·대비를 되살린다.
  float luma = dot(colour, vec3(0.3, 0.55, 0.15));
  colour = max(mix(vec3(luma), colour, 1.22), 0.0);
  colour = pow(colour, vec3(1.08));
  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class PaintPass {
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly material = new ShaderMaterial({
    uniforms: {
      tScene: { value: this.target.texture },
      uTexel: { value: new Vector2(1, 1) },
      uInk: { value: 0.35 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FRAGMENT,
    toneMapped: true,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);
  private readonly scene = new Scene().add(this.quad);
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /** 그림 크기(장치 화소). 캔버스 크기가 바뀌면 부른다. */
  setSize(width: number, height: number) {
    this.target.setSize(width, height);
    (this.material.uniforms.uTexel!.value as Vector2).set(1 / width, 1 / height);
  }

  /** 장면을 대상 질감에 그린 뒤 그림 필터를 거쳐 화면에 그린다. */
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
