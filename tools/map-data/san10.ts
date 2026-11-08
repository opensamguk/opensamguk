import { readFileSync } from 'node:fs';
import { operationalMapSchema, type OperationalMapResource } from '../../packages/rules/src/world/map/operational';
import { scenarioSchema, type ScenarioResource } from '../../packages/rules/src/world/resources';
import { applyProvinceRegions } from './provinces';

const root = new URL('../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
interface DraftSite {
  id: string;
  name: string;
  role: string;
  strategic: boolean;
  level?: number | null;
  position: { x: number; y: number };
  parentSiteId?: string;
}
interface Edge {
  id: string;
  from: string;
  to: string;
  mode: string;
}
interface Draft {
  sites: DraftSite[];
  connections: Edge[];
  proposedConnections: Edge[];
  operationalSiteAliases: Record<string, string>;
  canvas: { width: number; height: number };
  coordinateSystem: { bounds: [number, number, number, number] };
}

// 화면 표식 크기(지도 단위, apps/web/src/main/siteMarkers.ts의 LEVEL_UNITS·FACILITY_UNITS와 같다).
// D-050: 초안의 일본 서부·시코쿠 지역 대표 거점은 『三國志』 왜인조의 나라 이름으로 내보낸다. 원문은 이 나라들의
// 위치를 적지 않아(其餘旁國遠絕，不可得詳) 거점 배정은 비정설을 따른 작업 기준이다. 초안은 조사 기록이라 그대로 둔다.
const SINO_KOREAN_NAMES: Record<string, string> = {
  이즈모: '투마국', // 投馬國
  기비: '지유국', // 支惟國
  이요: '이사국', // 伊邪國
  사누키: '파리국', // 巴利國
};

// D-052: 한반도·왜는 이(4)를 쓰지 않고 대·중·소로 나눈다. 호수는 『三國志』 卷30 東夷傳,
// 낙랑은 『後漢書』 郡國志다. 사용자 결정(2026-11-01)으로 한반도·왜의 나라는 가장 작아도 소(5)이고,
// 호수가 없거나 작은 나라·바다 교역 섬도 소다. 한 縣인 서안평과 한반도·왜 밖의 이주는 이 바닥에서 뺀다.
const EAST_ASIA_LEVELS: Record<string, number> = {
  S149: 7, // 부여 「戶八萬」
  S133: 7, // 야마타이국 「可七萬餘戶」, 여왕 도읍
  S082: 6, // 낙랑 「十八城，户六万一千四百…」
  S140: 6, // 국내성 고구려 「戶三萬」, 도읍(丸都)
  S134: 6, // 투마국 「可五萬餘户」
  S145: 6, // 목지국 「辰王治月支國」, 마한 「總十餘萬戶」
  S131: 5, // 노국 「有二萬餘户」
  S142: 5, // 화려 예 「戶二萬」의 대표 거점
  S127: 5, // 대마국 「有千餘戶…乘船南北市糴」
  S128: 5, // 일지국 「有三千許家…亦南北市糴」
  S129: 5, // 말로국 「有四千餘戶」
  S130: 5, // 이도국
  S132: 5, // 불미국
  S135: 5, // 지유국
  S136: 5, // 이사국
  S137: 5, // 파리국
  S139: 5, // 졸본
  S141: 5, // 부조
  S143: 5, // 불이
  S144: 5, // 백제국
  S146: 5, // 건마국
  S147: 5, // 사로국
  S148: 5, // 구야국
  S150: 5, // 읍루
  S151: 5, // 북옥저
  S152: 5, // 주호 「乘船往來，巿買韓中」
  S153: 1, // 이주
};
// D-054: SAN10 원작의 OUTPOST라 진(2)으로 들어온 중원 치소 세 곳을 『後漢書』 郡國志와 사서로 올린다
// (사용자 결정 2026-11-01). 초는 che·통합 지도의 소(5)와 상속 수치로 되돌린다.
const CENTRAL_PLAINS_LEVELS: Record<string, number> = {
  S095: 6, // 진 陳國 「口百五十四萬七千五百七十二」, 「陳獨富強…有眾十餘萬」(資治通鑑 卷062)
  S093: 5, // 팽성 彭城國 「口四十九萬三千二十七」, 「屠彭城，獲其相侯諧。進至下邳」(三國志 武帝紀)
  S096: 5, // 초 沛國 「譙，刺史治」, 魏 五都 「改長安、譙、許昌、鄴、洛陽爲五都」(三國志 文帝紀 注 魏略)
  // D-055: 진(2)으로 들어온 191년 郡國 치소를 소(5)로 올린다. 口 수는 『後漢書』 郡國志다.
  S017: 5, // 양평 遼東郡 치소 襄平. 191 공손도의 수도
  S086: 5, // 임치 齊國 「臨菑，本齊，刺史治」 口四十九萬一千七百六十五
  S089: 5, // 하동 河東郡 치소 安邑 口五十七萬八百三
  S091: 5, // 정도 濟陰郡 치소 定陶 口六十五萬七千五百五十四
  S088: 5, // 낭야 琅邪國 口五十七萬九百六十七
  S084: 5, // 거록 鉅鹿郡 口六十萬二千九十六
  S112: 5, // 광릉 廣陵郡 치소 廣陵 口四十一萬百九十
  S110: 5, // 남창 豫章郡 치소 南昌 口百六十六萬八千九百六
  S087: 5, // 태산 泰山郡 口四十三萬七千三百一十七
  S014: 5, // 상당 上黨郡 口十二萬七千四百三
  S119: 5, // 창오 蒼梧郡 치소 廣信 口四十六萬六千九百七十五
  S049: 5, // 영창 永昌郡
  S072: 5, // 월수 越巂郡 치소 邛都
  S060: 5, // 적도 隴西郡 치소 狄道 口二萬九千六百三十七
};
const LEVEL_OVERRIDES: Record<string, number> = { ...EAST_ASIA_LEVELS, ...CENTRAL_PLAINS_LEVELS };
// D-055: 길 없는 전장 표식이던 파양(豫章郡 鄱陽縣)을 진(2) 도시로 바꾸고 시상·남창과 잇는다.
const PROMOTED_FIELDS: Record<string, { key: number; level: number }> = { 'field:92': { key: 1154, level: 2 } };
// D-052: 사료의 섬 두 곳을 더한다. 좌표는 위경도를 지도 공식((경도-94)·700/27, (54.0286-위도)·700/27)으로 옮겼다.
// 주호는 『三國志』 卷30 「州胡在馬韓之西海中大島上」(제주도로 비정), 이주는 卷47 吳主傳 「浮海求夷洲」
// (대만 비정은 학설이다). 연결은 권역을 잇는 게임 연결이며 고대 항로 판독이 아니다.
const EXTRA_SITES: DraftSite[] = [
  { id: 'S152', name: '주호', role: 'DOCUMENTED_POLITY', strategic: true, position: { x: 844, y: 535 } },
  { id: 'S153', name: '이주', role: 'DOCUMENTED_POLITY', strategic: true, position: { x: 690, y: 781 } },
];
// D-052: 초안의 게임 배치가 치소와 멀어 강 기슭이 뒤집히던 거점을 치소 위경도로 옮긴다.
// 하동은 河東郡 치소 安邑(지금 夏縣 서북 禹王城, 약 북위 35.13·동경 111.20)이고 黃河 북안이다.
const POSITION_OVERRIDES: Record<string, { x: number; y: number }> = {
  S089: { x: 446, y: 490 },
};
const EXTRA_CONNECTIONS: Edge[] = [
  { id: 'EA46', from: 'S146', to: 'S152', mode: 'WATER' }, // 건마국-주호
  { id: 'EA47', from: 'S035', to: 'S153', mode: 'WATER' }, // 건안-이주
  // D-055: 주변 거점은 가까운 거점부터 이어 전체가 한 덩어리가 되는 만큼만 둔다.
  { id: 'P15.1', from: 'S120', to: 'S002', mode: 'LAND' }, // 강-서평
  { id: 'P16.1', from: 'S126', to: 'S062', mode: 'LAND' }, // 저-기산
  { id: 'EA48', from: 'S143', to: 'S144', mode: 'LAND' }, // 불이-백제국
  { id: 'F92.1', from: 'field:92', to: 'S036', mode: 'LAND' }, // 파양-시상
  { id: 'F92.2', from: 'field:92', to: 'S110', mode: 'LAND' }, // 파양-남창
];
// D-055: 가까운 거점을 건너뛰거나 같은 덩어리를 한 번 더 잇는 주변 제안 연결을 뺀다(45 → 32).
const DROPPED_CONNECTIONS = new Set([
  'P01.1', // 강-무위
  'P02.1', // 강-적도
  'P04.1', // 남만-영창
  'P07.1', // 산월-회계
  'P08.1', // 선비-구원
  'P11.1', // 흉노-진양
  'P12.1', // 저-무위
  'P13.1', // 저-천수
  'P14.1', // 저-가정
  'EA02', // 서안평-낙랑
  'EA06', // 국내성-부조
  'EA09', // 북옥저-부조
  'EA13', // 낙랑-백제국
  'EA16', // 목지국-사로국
  'EA19', // 불이-사로국
  'EA27', // 불미국-지유국
]);

const LEVEL_UNITS = [5, 6, 4, 6, 6, 7, 8, 9, 11, 13];
// D-052: 관은 12단위 긴 성벽 띠라 띄울 때는 긴 변으로 잰다.
const FACILITY_UNITS = { PASS: 12, PORT: 6, FIELD: 3.5 } as const;
const SPREAD_GAP = 4;
const SPREAD_LIMIT = 12;

// INT-20 사용자 요청: 표식이 붙거나 겹치는 거점을 띄운다. 두 표식 크기 합의 절반에 4단위를 더한 거리보다
// 가까우면 같은 거리만큼 서로 밀고, 거점마다 원래 자리에서 12단위 안에서만 움직인다. 좌표는 화면 표시용이라
// 규칙은 바뀌지 않는다. 정해진 순서로 반복해 늘 같은 결과가 나온다.
function spreadSites(sites: OperationalMapResource['sites']) {
  const units = (site: OperationalMapResource['sites'][number]) =>
    site.kind === 'CITY' ? (LEVEL_UNITS[site.level] ?? 7) : FACILITY_UNITS[site.kind];
  const origin = sites.map((site) => ({ ...site.position }));
  for (let round = 0; round < 60; round += 1) {
    let moved = false;
    for (let i = 0; i < sites.length; i += 1)
      for (let j = i + 1; j < sites.length; j += 1) {
        const a = sites[i]!.position;
        const b = sites[j]!.position;
        const need = (units(sites[i]!) + units(sites[j]!)) / 2 + SPREAD_GAP;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= need) continue;
        if (distance === 0) [dx, dy, distance] = [1, 0, 1];
        const push = Math.min(0.5, (need - distance) / 2);
        a.x -= (dx / distance) * push;
        a.y -= (dy / distance) * push;
        b.x += (dx / distance) * push;
        b.y += (dy / distance) * push;
        moved = true;
      }
    for (let i = 0; i < sites.length; i += 1) {
      const at = sites[i]!.position;
      const from = origin[i]!;
      const shift = Math.hypot(at.x - from.x, at.y - from.y);
      if (shift > SPREAD_LIMIT) {
        at.x = from.x + ((at.x - from.x) * SPREAD_LIMIT) / shift;
        at.y = from.y + ((at.y - from.y) * SPREAD_LIMIT) / shift;
      }
    }
    if (!moved) break;
  }
  for (const site of sites) site.position = { x: Math.round(site.position.x), y: Math.round(site.position.y) };
}

export function buildSan10Map(gisHash: string): OperationalMapResource {
  const draft: Draft = read('resources/map-drafts/san10/adopted-placement.json');
  const old = operationalMapSchema.parse(read('resources/map/integration.json'));
  const ids = new Map<string, string>();
  const inheritedOf = (site: Draft['sites'][number]) =>
    old.sites.find((row) => draft.operationalSiteAliases[row.id] === site.id);
  // D-055: 새 도시의 최대치는 같은 규모 기존 도시의 항목별 중앙값이다. 기존 도시가 없는 규모(1·4)는 규모 비례식을 쓴다.
  const oldCities = old.sites.flatMap((row) => (row.kind === 'CITY' ? [row] : []));
  const maxFor = (level: number) => {
    const same = oldCities.filter((row) => row.level === level).map((row) => row.max);
    const median = (key: keyof (typeof same)[number]) => {
      const values = same.map((max) => max[key]).sort((a, b) => a - b);
      return values[Math.floor((values.length - 1) / 2)]!;
    };
    return same.length
      ? {
          population: median('population'),
          agriculture: median('agriculture'),
          commerce: median('commerce'),
          security: median('security'),
          defence: median('defence'),
          wall: median('wall'),
        }
      : {
          population: level * 50000,
          agriculture: level * 1000,
          commerce: level * 1000,
          security: 2000,
          defence: level * 2000,
          wall: level * 2000,
        };
  };
  // D-049: SAN10에는 물길이 없어 항구 시설은 지도 자료에서 뺀다. 전장 표식은 남긴다.
  const kept = [...draft.sites.filter((site) => site.strategic || inheritedOf(site)?.kind !== 'PORT'), ...EXTRA_SITES];
  const sites: OperationalMapResource['sites'] = kept.map((site) => {
    const inherited = inheritedOf(site);
    const common = {
      name: SINO_KOREAN_NAMES[site.name] ?? site.name,
      position: { ...(POSITION_OVERRIDES[site.id] ?? site.position) },
    };
    const promoted = PROMOTED_FIELDS[site.id];
    if (!site.strategic && !promoted) {
      if (!inherited || (inherited.kind !== 'PORT' && inherited.kind !== 'FIELD'))
        throw Error(`시설 대응 없음: ${site.id}`);
      ids.set(site.id, inherited.id);
      return { ...inherited, ...common };
    }
    const key =
      promoted?.key ?? (inherited && 'anchorKey' in inherited ? inherited.anchorKey : 1000 + Number(site.id.slice(1)));
    const kind = site.role === 'PASS' ? 'PASS' : 'CITY';
    const id = `${kind.toLowerCase()}:${key}`;
    ids.set(site.id, id);
    if (kind === 'PASS') {
      if (inherited?.kind !== 'PASS') throw Error(`관문 대응 없음: ${site.name}`);
      return { ...inherited, ...common, id };
    }
    if (inherited?.kind === 'CITY') {
      const level = LEVEL_OVERRIDES[site.id] ?? site.level ?? inherited.level;
      // D-055: 규모를 바꾼 상속 도시는 새 규모의 최대치를 쓴다. 같으면 상속 수치 그대로다.
      return { ...inherited, ...common, id, level, ...(level === inherited.level ? {} : { max: maxFor(level) }) };
    }
    const level = promoted?.level ?? LEVEL_OVERRIDES[site.id] ?? site.level ?? 2;
    return {
      ...common,
      id,
      kind: 'CITY',
      anchorKey: key,
      level,
      // 모든 도시·관문의 최종 region은 아래의 검수 대응표로 채운다.
      region: 1,
      initial: {
        population: level * 2500,
        agriculture: level * 50,
        commerce: level * 50,
        security: 100,
        defence: level * 250,
        wall: level * 250,
      },
      max: maxFor(level),
    };
  });
  const assignedSites = applyProvinceRegions(sites, read('resources/map-drafts/san10/provinces.json'));
  spreadSites(assignedSites);
  const routes = [...draft.connections, ...draft.proposedConnections, ...EXTRA_CONNECTIONS]
    .filter((edge) => !DROPPED_CONNECTIONS.has(edge.id))
    .map((edge) => ({
      id: edge.id.startsWith('route:') ? edge.id : `route:san10-${edge.id.toLowerCase().replaceAll('.', '-')}`,
      from: ids.get(edge.from)!,
      to: ids.get(edge.to)!,
      mode: 'LAND' as const,
      direction: 'BOTH' as const,
      enabled: true,
    }));
  return operationalMapSchema.parse({
    version: 3,
    id: 'san10',
    name: 'SAN10 통합 지도',
    regionScheme: 'province-191',
    canvas: draft.canvas,
    basemap: {
      source: 'natural-earth-5.1.2',
      projection: 'WGS84 plate carree',
      sha256: gisHash,
      bounds: draft.coordinateSystem.bounds,
    },
    defaults: old.defaults,
    sites: assignedSites,
    routes,
  });
}

// 수도에서 같은 나라 땅으로 이어지지 않던 영토를 잇는 공백지 (사용자 결정 2026-11-01, D-053).
// 끊긴 도시 쪽에서 수도 덩어리까지 공백지만 지나는 최단 경로이며 경로는 모두 하나뿐이다.
export const SAN10_191_GAP_FILL: Readonly<Record<string, readonly string[]>> = {
  원소: ['계교'],
  유표: ['번성', '신야', '의양'],
  유언: ['강양'],
  이각: ['화산', '동관'],
  // D-055: 저-무위·저-천수를 빼면서 무위와 천수·저가 끊겨 무위-서평-적도-남안-천수, 천수-기산-저를 잇는다.
  마등: ['서평', '적도', '남안', '기산', '저'],
  유요: ['유수구', '석정'],
};
// 공백지로 이을 길이 없는 영토는 공백지로 돌린다 (원술의 여남은 공주의 수도 초를 지나야만 닿는다).
export const SAN10_191_RELEASE: Readonly<Record<string, readonly string[]>> = { 원술: ['여남'] };

export function buildSan10MapV2(map: OperationalMapResource): OperationalMapResource {
  return operationalMapSchema.parse({
    ...map,
    sites: [
      ...map.sites,
      {
        id: 'pass:72',
        name: '사곡관',
        kind: 'PASS',
        anchorKey: 72,
        legacyCityId: 72,
        position: { x: 457, y: 505 },
        region: 1,
        defence: { initial: 1000, max: 9900 },
        wall: { initial: 1000, max: 10100 },
      },
    ],
    routes: [
      ...map.routes,
      ...[3, 42].map((key) => ({
        id: `route:land-${key}-72`,
        from: `city:${key}`,
        to: 'pass:72',
        mode: 'LAND',
        direction: 'BOTH',
        enabled: true,
      })),
    ],
  });
}

export function buildSan10Scenarios(map: OperationalMapResource, original1030: unknown) {
  const draft: Draft = read('resources/map-drafts/san10/adopted-placement.json');
  const old = operationalMapSchema.parse(read('resources/map/integration.json'));
  const source = scenarioSchema.parse(read('resources/scenario/integration191.json'));
  const renamed = new Map(
    old.sites.map((site) => [
      site.name,
      draft.sites.find((row) => row.id === draft.operationalSiteAliases[site.id])!.name,
    ]),
  );
  const name = (value: string) => renamed.get(value) ?? value;
  const historical: ScenarioResource = {
    ...source,
    id: 'san10-191',
    title: 'SAN10 역사 · 191년 군웅할거',
    nation: source.nation.map((row) => {
      const copy = structuredClone(row);
      copy[8] = row[8].map(name);
      return copy;
    }),
    general: source.general.map((row) => {
      const copy = structuredClone(row);
      if (copy[4] !== null) copy[4] = name(copy[4]);
      return copy;
    }),
  };
  // 예전에는 표시뿐이던 네 거점도 원본의 소유국으로 돌려준다. 수도는 현재 정식 대응을 유지한다.
  const original = scenarioSchema.parse(original1030);
  const existingOwners = new Set(historical.nation.flatMap((row) => row[8]));
  original.nation.forEach((row, index) => {
    for (const oldName of row[8]) {
      const target = name(oldName);
      if (!existingOwners.has(target) && map.sites.some((site) => 'anchorKey' in site && site.name === target)) {
        historical.nation[index]![8].push(target);
        existingOwners.add(target);
      }
    }
  });
  // D-053: 수도와 끊긴 영토 사이의 공백지를 그 나라에 넣어 잇는다. 수도(첫 도시)는 그대로다.
  for (const [nationName, cities] of Object.entries(SAN10_191_GAP_FILL)) {
    const row = historical.nation.find((nation) => nation[0] === nationName)!;
    for (const city of cities) {
      if (existingOwners.has(city)) throw new Error(`${nationName}: ${city}는 이미 소유국이 있다`);
      row[8].push(city);
      existingOwners.add(city);
    }
  }
  for (const [nationName, cities] of Object.entries(SAN10_191_RELEASE)) {
    const row = historical.nation.find((nation) => nation[0] === nationName)!;
    for (const city of cities) {
      if (!row[8].includes(city) || row[8][0] === city)
        throw new Error(`${nationName}: ${city}는 수도가 아닌 영토여야 한다`);
      row[8] = row[8].filter((name) => name !== city);
    }
  }
  const empty: ScenarioResource = {
    ...historical,
    id: 'san10-empty',
    title: 'SAN10 공백지 · 180년 난세 개막',
    startYear: 180,
    nation: [],
    diplomacy: [],
    general: historical.general.map((row) => {
      const copy = structuredClone(row);
      copy[3] = 0;
      copy[8] = 0;
      return copy;
    }),
  };
  return { historical: scenarioSchema.parse(historical), empty: scenarioSchema.parse(empty) };
}
