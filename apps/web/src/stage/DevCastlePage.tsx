// 개발 전용 성 화면 확인 판(/dev/castle). 서버 없이 양식, 등급, 건물 단계를 바꿔 CityScene을 본다.
// 사용자 2026-11-17: "그럼 웹쪽을 업데이트 해야지." 시안(castle-panorama) 대신 웹 성 화면을 기준으로 삼는다.
import { useMemo, useState } from 'react';
import { cityLandSlots, type CityGrade } from '@opensamguk/shared';
import { PUBLIC_IMAGES } from '@opensamguk/shared/public-images';
import { CityScene, type CityLand } from './CityScene';
import { ROLE_KIND } from './cityTalk';
import sites from './castleSites.json';
import common from './cityTalk/common.json';

export const DEV_STYLES = [
  ['central', '중원'],
  ['hebei', '하북'],
  ['liang', '서량'],
  ['jing', '형주'],
  ['yang', '강남'],
  ['ba-shu', '파촉'],
  ['nanzhong', '남중'],
  ['east-goguryeo', '고구려'],
  ['east-buyeo', '부여'],
  ['east-eupru', '읍루'],
  ['east-okjeo-ye', '옥저, 동예'],
  ['east-mahan', '마한'],
  ['east-jinbyeon', '진한, 변한'],
  ['east-wa', '왜'],
  ['tribe-xiongnu', '흉노'],
  ['tribe-xianbei', '선비'],
  ['tribe-wuhuan', '오환'],
  ['tribe-qiang', '강'],
  ['tribe-di', '저'],
  ['tribe-nanman', '남만'],
  ['tribe-shanyue', '산월'],
  ['tribe-yizhou', '이주'],
] as const;
const STYLE_NAME = new Map<string, string>(DEV_STYLES);
/** 성마다 그린 성벽이 있는 거점(D:/codex-artifacts/int29-castle-slots-20261116/city-design에서 뽑음). */
const SITES = sites as ReadonlyArray<{ key: number; name: string; style: string; grade: CityGrade }>;
const GRADES: ReadonlyArray<[CityGrade, number]> = [
  ['현', 4],
  ['소', 5],
  ['중', 6],
  ['대', 7],
  ['특', 8],
  ['경', 9],
];
type Fill = 'empty' | 1 | 2 | 3 | 'mixed';

/**
 * 그 양식 폴더에 그림이 있는 지역 고유 건물 키(기본 48종이 아닌 것). 웹은 rules 건물 표를 읽지 못하므로
 * 그림 목록(city/slots/<양식>/<키>-<단계>…)에서 찾는다(사용자 2026-11-18 지역 건물 그림 웹에 올리기).
 */
export function regionKeys(style: string): string[] {
  const prefix = `apps/web/src/art/city/slots/${style}/`;
  const keys = new Set<string>();
  for (const { source } of PUBLIC_IMAGES) {
    if (!source.startsWith(prefix)) continue;
    const key = /^([a-z_]+)-[123](?:-ground|-building)?\.webp$/.exec(source.slice(prefix.length))?.[1];
    // 태수부(palace), 집(house), 빈 터(lot), 공사 터(build)는 건물이 아니라 뺀다.
    if (key && !(key in ROLE_KIND) && !['palace', 'house', 'lot', 'build'].includes(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** 슬롯마다 그 구역에 지을 수 있는 건물을 차례로 채운 가짜 땅. 양식을 주면 그 양식 지역 건물을 성 밖 앞자리에 먼저 놓는다. */
export function devLand(level: number, fill: Fill, style?: string): CityLand {
  const slots = cityLandSlots('CITY', level);
  // 건물 키 순서는 rules 건물 목록과 같고 앞 16종이 성 안 건물이다.
  const keys = Object.keys(ROLE_KIND);
  const inside = keys.slice(0, 16);
  // 지역 건물의 안팎은 rules에만 있어서 확인 판에서는 모두 성 밖 앞자리에 둔다(그림 확인용).
  const outside = [...(style ? regionKeys(style) : []), ...keys.slice(16)];
  let ni = 0;
  let no = 0;
  return {
    cityKey: 0,
    grade: null,
    core: 0,
    buildings: [],
    slots: slots.map((slot, n) => {
      if (fill === 'empty') return { ...slot, building: null };
      const list = slot.zone === 'inside' ? inside : outside;
      const key = list[(slot.zone === 'inside' ? ni++ : no++) % list.length]!;
      const lv = fill === 'mixed' ? (n % 3) + 1 : fill;
      const pending = fill === 'mixed' && n % 7 === 3;
      return {
        ...slot,
        building: {
          slotId: slot.id,
          building: key,
          remainingTurns: pending ? 1 : 0,
          score: Math.round((100 * (lv - 0.5)) / 3),
        },
      };
    }),
  };
}

/** prepareStyle: 양식을 바꾸기 전에 그 양식 그림을 준비한다(미리보기 아티팩트가 묶음을 받는다). */
export function DevCastlePage({ prepareStyle }: { prepareStyle?: (style: string) => Promise<void> } = {}) {
  const [style, setStyleNow] = useState('east-okjeo-ye');
  const [busy, setBusy] = useState<string | null>(null);
  const setStyle = (next: string) => {
    if (!prepareStyle) return setStyleNow(next);
    setBusy(next);
    void prepareStyle(next).finally(() => {
      setBusy(null);
      setStyleNow(next);
    });
  };
  const [level, setLevel] = useState(7);
  const [fill, setFill] = useState<Fill>('mixed');
  const [season, setSeason] = useState<'spring' | 'summer' | 'autumn' | 'winter'>('spring');
  const [water, setWater] = useState<'none' | 'coast' | 'river'>('none');
  const [conds, setConds] = useState<string[]>([]);
  // 승격 공사 중 비계(INT-30).
  const [upgrading, setUpgrading] = useState(false);
  // 거점 번호: 성마다 따로 그린 성벽(castle-walls/city-<번호>)을 본다(사용자 2026-11-17 "250곳 모두 고유").
  // 이름을 고르면 그 성의 양식과 등급으로 맞추고, 미리보기 아티팩트는 그 성 성벽 묶음(city-<번호>)을 먼저 받는다.
  const [siteKey, setSiteKey] = useState<number | undefined>(undefined);
  const site = SITES.find((s) => s.key === siteKey);
  const pickSite = (key: number | undefined) => {
    const next = SITES.find((s) => s.key === key);
    if (!next) return setSiteKey(undefined);
    const apply = () => {
      setBusy(null);
      setStyleNow(next.style);
      setLevel(GRADES.find(([g]) => g === next.grade)?.[1] ?? level);
      setSiteKey(next.key);
    };
    if (!prepareStyle) return apply();
    setBusy(next.style);
    void Promise.all([prepareStyle(next.style), prepareStyle(`city-${next.key}`)]).finally(apply);
  };
  const land = useMemo(() => devLand(level, fill, style), [level, fill, style]);
  const row = (
    label: string,
    items: ReadonlyArray<readonly [string | number, string]>,
    now: string | number,
    pick: (v: never) => void,
  ) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <b style={{ minWidth: 48 }}>{label}</b>
      {items.map(([v, name]) => (
        <button key={String(v)} type="button" aria-pressed={now === v} onClick={() => pick(v as never)}>
          {name}
        </button>
      ))}
    </div>
  );
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        height: '100vh',
        background: '#1b140e',
        color: '#f5e6c8',
      }}
    >
      <div style={{ display: 'grid', gap: 4, padding: 8, fontSize: 13 }}>
        {row('양식', DEV_STYLES, busy ?? style, setStyle)}
        {row(
          '등급',
          GRADES.map(([g, lv]) => [lv, g] as const),
          level,
          setLevel,
        )}
        {row(
          '건물',
          [
            ['empty', '빈 땅'],
            [1, '1단계'],
            [2, '2단계'],
            [3, '3단계'],
            ['mixed', '섞기(공사 포함)'],
          ],
          fill,
          setFill,
        )}
        {row(
          '계절',
          [
            ['spring', '봄'],
            ['summer', '여름'],
            ['autumn', '가을'],
            ['winter', '겨울'],
          ],
          season,
          setSeason,
        )}
        {row(
          '물가',
          [
            ['none', '없음'],
            ['river', '강가'],
            ['coast', '바닷가'],
          ],
          water,
          setWater,
        )}
        {row(
          '공사',
          [
            ['no', '없음'],
            ['yes', '승격 공사 중'],
          ],
          upgrading ? 'yes' : 'no',
          (v: string) => setUpgrading(v === 'yes'),
        )}
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <b style={{ minWidth: 48 }}>거점</b>
          <select
            id="dev-castle-site"
            value={siteKey ?? ''}
            onChange={(event) => pickSite(event.target.value ? Number(event.target.value) : undefined)}
            style={{ maxWidth: '100%' }}
          >
            <option value="">양식 기본 성벽</option>
            {GRADES.slice()
              .reverse()
              .map(([g]) => (
                <optgroup key={g} label={`${g} 거점`}>
                  {SITES.filter((s) => s.grade === g).map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name} ({STYLE_NAME.get(s.style) ?? s.style}, {s.key})
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <b style={{ minWidth: 48 }}>상황</b>
          {(common.situations as Array<[string, string, string]>).map(([key, name]) => (
            <button
              key={key}
              type="button"
              aria-pressed={conds.includes(key)}
              onClick={() => setConds((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div style={{ position: 'relative', minHeight: 0 }}>
        <CityScene
          cityName={site?.name ?? '시험'}
          kind="CITY"
          level={level}
          land={land}
          style={style}
          season={season}
          water={water === 'none' ? null : water}
          conditions={conds}
          upgrading={upgrading}
          talkContext={{ ruler: '조조', taesu: '순욱', enemy: '원소', generals: ['하후돈', '악진', '이전'] }}
          place={siteKey === undefined ? undefined : { key: siteKey }}
          onLot={() => undefined}
        />
      </div>
    </div>
  );
}
