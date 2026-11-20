// 공성 장면 A(모서리 성벽)와 B(치성 성벽)를 조각으로 쌓아 그린다 (docs/design/sam7-motif.md, 사용자 2026-11-15 "조각 구조로").
// 자리표는 Codex siegeA/, siegeB/ layout.json에 공개 그림 크기를 더한 siegeLayoutA.json, siegeLayoutB.json이다. layers를 아래부터 그리고,
// 재질(<m>), 날씨(<weather>), 성문 단계(<gate>), 손상 얼룩(<damage>)을 전황에 맞춰 바꿔 끼운다.
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import layoutA from './siegeLayoutA.json';
import layoutB from './siegeLayoutB.json';
import { damageStage, type SiegeLayoutKey, type SiegeMaterial } from './siegeRules';
import type { BattleFrame, Weather } from './types';
import styles from './TacticalBattleView.module.css';

type Point = readonly [number, number];
interface Layer {
  file: string;
  x?: number;
  y?: number;
  when?: string;
  points?: string;
  scale?: number;
}

interface SceneLayout {
  layers: Layer[];
  sizes: Record<string, readonly [number, number]>;
  scale_by_y: Point[];
  attack_zone: Point[];
  ladder: Point[];
  ladder_scale: number[];
  /** 성벽 면 쪽으로 기울게 좌우를 뒤집을 사다리 */
  ladder_flip?: boolean[];
  gate_front: Point;
  catapult: Point[];
  wall_top: Point[];
}
const LAYOUTS: Record<SiegeLayoutKey, { folder: string; layout: SceneLayout; core: string }> = {
  corner: { folder: 'siegeA', layout: layoutA as unknown as SceneLayout, core: 'corner' },
  bastion: { folder: 'siegeB', layout: layoutB as unknown as SceneLayout, core: 'bastion' },
};
const sourceOf = (key: SiegeLayoutKey, name: string) => `apps/web/src/art/battle/${LAYOUTS[key].folder}/${name}.webp`;

/** 그림이 승인 목록에 다 있으면 true. 없으면 화면이 예전 도식 성벽을 쓴다. */
export function siegeSceneReady(key: SiegeLayoutKey = 'bastion', material: SiegeMaterial = 'stone'): boolean {
  return ['ground', 'sky-clear', `${material}-${LAYOUTS[key].core}`, `${material}-wall-left`].every((name) =>
    hasPublicImage(sourceOf(key, name)),
  );
}

function perspective(layout: SceneLayout, y: number): number {
  const table = layout.scale_by_y;
  for (let i = 0; i + 1 < table.length; i++) {
    const [a, sa] = table[i]!;
    const [b, sb] = table[i + 1]!;
    if (y <= b) return sa + ((sb - sa) * Math.max(0, y - a)) / (b - a);
  }
  return table[table.length - 1]![1];
}

/** 바닥 중앙을 point에 맞춰 놓는다. */
function Sprite({
  scene,
  name,
  point,
  scale,
  flip = false,
}: {
  scene: SiegeLayoutKey;
  name: string;
  point: Point;
  scale: number;
  flip?: boolean | undefined;
}) {
  const size = LAYOUTS[scene].layout.sizes[name];
  const source = sourceOf(scene, name);
  if (!size || !hasPublicImage(source)) return null;
  const w = size[0] * scale;
  const h = size[1] * scale;
  const image = <image href={publicImageUrl(source)} x={point[0] - w / 2} y={point[1] - h} width={w} height={h} />;
  // 좌우 뒤집기는 바닥 중앙을 축으로 한다.
  return flip ? <g transform={`translate(${point[0] * 2},0) scale(-1,1)`}>{image}</g> : image;
}

/** 야전 기상(D-105)을 공성 하늘 그림으로. 서버가 siege.weather를 보내면 그쪽이 우선이다. */
export function skyOf(weather: Weather | undefined): 'clear' | 'cloud' | 'rain' | 'snow' {
  if (weather === 'rain' || weather === 'downpour') return 'rain';
  if (weather === 'snow') return 'snow';
  if (weather === 'fog') return 'cloud';
  return 'clear';
}

export function SiegeScene({ frame }: { frame: BattleFrame }) {
  const siege = frame.siege!;
  const scene: SiegeLayoutKey = siege.layout ?? 'bastion';
  const { layout } = LAYOUTS[scene];
  const material: SiegeMaterial = siege.material ?? 'stone';
  const weather = siege.weather ?? skyOf(frame.environment?.weather);
  const damage = damageStage(siege.defense, siege.defenseMax);
  const gateLost = 1 - siege.gate / Math.max(1, siege.gateMax);
  const gate = siege.gate <= 0 ? 2 : gateLost > 1 / 3 ? 1 : 0;
  const attackers = frame.units.filter((unit) => unit.side === 'attack' && unit.status !== 'routed').length;
  const defenders = frame.units.filter((unit) => unit.side === 'defend' && unit.status !== 'routed').length;
  const resolve = (file: string) =>
    file
      .replace('<m>', material)
      .replace('<weather>', weather)
      .replace('<damage>', String(damage))
      .replace('<gate>', String(gate))
      .replace(/\.png$/, '');

  // 치성 장면처럼 눈 하늘이 없는 벌은 흐린 하늘로 대신한다.
  const skyFile = (file: string) =>
    file.includes('<weather>') && !hasPublicImage(sourceOf(scene, resolve(file)))
      ? file.replace('<weather>', 'cloud')
      : file;
  const layers = layout.layers.flatMap((raw, index) => {
    if (raw.when === 'damage' && damage === 0) return [];
    const layer = { ...raw, file: skyFile(raw.file) };
    if (layer.file === '@ground_objects') {
      // 공격 무리는 남은 부대 수만큼(자리 5곳까지), 병기는 사다리, 충차, 투석기. 먼 것부터 그린다.
      const zone = layout.attack_zone;
      const ladders = layout.ladder;
      const objects: Array<{ name: string; point: Point; scale?: number; flip?: boolean | undefined }> = [
        ...zone.slice(0, Math.max(1, Math.min(zone.length, attackers))).map((point, i) => ({
          name: `attackers-${(i % 3) + 1}`,
          point,
        })),
        ...ladders.map((point, i) => ({
          name: 'engines-ladder',
          point,
          scale: layout.ladder_scale[i],
          flip: layout.ladder_flip?.[i],
        })),
        ...(siege.gate > 0 ? [{ name: 'engines-ram', point: layout.gate_front }] : []),
        ...layout.catapult.map((point) => ({ name: 'engines-catapult', point })),
      ].sort((a, b) => a.point[1] - b.point[1]);
      return objects.map((object, i) => (
        <g key={`o${index}-${i}`}>
          <ellipse cx={object.point[0]} cy={object.point[1]} rx={48} ry={8} className={styles.siegeShadow} />
          <Sprite
            scene={scene}
            name={object.name}
            point={object.point}
            scale={object.scale ?? perspective(layout, object.point[1])}
            flip={object.flip}
          />
        </g>
      ));
    }
    if (layer.points) {
      // 수비 무리는 성벽 위 자리에 남은 부대 수만큼 선다. 원래 비율로는 작아 1.5배로 키운다.
      const points = (layout as unknown as Record<string, Point[] | undefined>)[layer.points] ?? [];
      return points
        .slice(0, Math.max(1, Math.min(points.length, defenders * 2)))
        .map((point, i) => (
          <Sprite
            key={`p${index}-${i}`}
            scene={scene}
            name={resolve(layer.file)}
            point={point}
            scale={(layer.scale ?? 1) * 1.5}
          />
        ));
    }
    const name = resolve(layer.file);
    const size = layout.sizes[name];
    const source = sourceOf(scene, name);
    if (!size || !hasPublicImage(source)) return [];
    return [
      <image
        key={`l${index}`}
        href={publicImageUrl(source)}
        x={layer.x ?? 0}
        y={layer.y ?? 0}
        width={size[0]}
        height={size[1]}
      />,
    ];
  });

  return (
    <svg
      className={styles.siege}
      viewBox="0 0 1600 900"
      // 무대를 빈틈없이 덮는다. 넘치는 가장자리는 잘린다.
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`성벽 손상 ${damage}단계, 성문 ${gate === 0 ? '멀쩡함' : gate === 1 ? '쪼개짐' : '부서짐'}`}
    >
      {layers}
    </svg>
  );
}
