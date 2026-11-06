import { z } from 'zod';
import { unitSetSchema, type UnitSetResource } from '../../packages/rules/src/world/resources';
import type { OperationalMapResource } from '../../packages/rules/src/world/map/operational';
import { validateUnitSet } from '../../packages/rules/src/world/validate/unitSet';

type Unit = UnitSetResource['crewTypes'][number];
type Requirement = NonNullable<Unit['requirements']>[number];
type ExpandedUnit = Unit & { info: string[] };
export type ExpandedUnitSet = Omit<UnitSetResource, 'crewTypes'> & { crewTypes: ExpandedUnit[] };
const tech = (min: number): Requirement => ({ kind: 'tech', min });
const regions = (...values: number[]): Requirement => ({ kind: 'regions', regions: values });
const research = (name: Extract<Requirement, { kind: 'research' }>['name']): Requirement => ({
  kind: 'research',
  name,
});

// INT-22 승인 표의 계열 상성. 차병의 병종 ID 예외는 원본에서 따로 보존한다.
const affinities: Record<number, number[]> = {
  1: [1, 1, 1.2, 0.8, 1, 1.2],
  2: [1, 0.8, 1, 1.2, 1.2, 1.2],
  3: [1, 1.2, 0.8, 1, 0.8, 1.2],
  4: [1, 1, 0.8, 1.2, 1, 1.2],
};
const references: Record<number, string> = {
  1101: '資治通鑑 卷62: 道逢青州兵劫掠人',
  1110: '三國志 卷32 先主傳: 謙以丹楊兵四千益先主',
  1111: '三國志 卷31 劉二牧傳: 焉出青羌與戰',
  1112: '晉書 卷120: 募賨人平定三秦',
  1113: '三國志 卷62: 立解煩兩部',
  1401: '三國志 卷30 倭人條: 兵用矛、楯、木弓',
  1402: '資治通鑑 卷62: 名陷陳營',
  1403: '三國志 卷6: 大戟士百餘人自隨',
  1210: '三國志 卷30: 出好弓，所謂貊弓是也',
  1301: '後漢書 卷73: 自號白馬義從',
  1310: '三國志 卷30: 三郡烏丸爲天下名騎',
  1307: '三國志 卷9: 督虎豹騎從圍南皮',
};
const fictional = new Set([
  1102, 1103, 1104, 1105, 1106, 91100, 91101, 91102, 1201, 1202, 1203, 1204, 91200, 91201, 91202, 1302, 1303, 1304,
  1305, 1306, 91300, 91301, 91302,
]);
// D-056 2026-11-06: 원작과 다른 수치는 새 expanded 판에만 적용한다.
const balance: Record<number, Partial<Pick<Unit, 'attack' | 'defence' | 'cost'>>> = {
  1400: { attack: 102 },
  91102: { attack: 283 },
  1501: { defence: 250 },
  1502: { defence: 150 },
  1503: { defence: 600 },
  91500: { defence: 1000 },
};

export function buildExpandedUnitSet(source: unknown, map: OperationalMapResource): ExpandedUnitSet {
  const original = z
    .looseObject({ crewTypes: z.array(z.looseObject({ requirements: z.unknown().optional() })) })
    .parse(source);
  const originalUnits = unitSetSchema.parse({
    ...original,
    crewTypes: original.crewTypes.map((unit) => ({ ...unit, requirements: undefined })),
  }).crewTypes;
  const byId = new Map(originalUnits.map((unit) => [unit.id, unit]));
  const cityKeys = (names: string[]) =>
    names.map((name) => {
      const found = map.sites.filter((site) => site.name === name && 'anchorKey' in site);
      if (found.length !== 1 || !('anchorKey' in found[0]!)) throw Error(`병종 조건 거점 대응을 확인하세요: ${name}`);
      return found[0]!.anchorKey;
    });
  const cities = (...names: string[]): Requirement => ({ kind: 'cities', cityKeys: cityKeys(names) });
  const large = (...names: string[]): Requirement => ({
    kind: 'citiesWithLevel',
    cityKeys: cityKeys(names),
    level: 8,
  });
  const conditions: Record<number, Requirement[]> = {
    1000: [{ kind: 'impossible' }],
    1100: [],
    1101: [tech(1000), regions(6, 4)],
    1102: [tech(1000), regions(8)],
    1103: [tech(2000), cities('저')],
    1104: [tech(3000), cities('낙양')],
    1105: [tech(1000), regions(10)],
    1106: [tech(3000), cities('성도')],
    // 丹楊郡의 秣陵에 대응한다. 丹徒(경구)는 呉郡이므로 제외한다(後漢書 卷112).
    1110: [tech(1000), cities('건업')],
    1111: [tech(2000), regions(9)],
    1112: [tech(2000), cities('강주')],
    1113: [tech(3000), cities('건업')],
    91100: [tech(4000), large('완'), research('greatsword')],
    91101: [tech(4000), large('북평')],
    91102: [tech(5000), large('저'), research('halberd')],
    1200: [],
    1201: [tech(1000), cities('오환', '선비')],
    1202: [tech(1000), regions(9)],
    1203: [tech(3000), cities('양양')],
    1204: [tech(3000), cities('건업')],
    1210: [tech(1000), cities('국내성', '졸본')],
    91200: [tech(4000), large('사로국')],
    91201: [tech(4000), large('장사'), research('fire_arrow')],
    91202: [tech(5000), large('흉노'), research('repeater')],
    1300: [],
    1301: [tech(1000), regions(3, 13)],
    1302: [tech(1000), regions(11)],
    1303: [tech(2000), cities('흉노')],
    1304: [tech(2000), cities('강')],
    1305: [tech(2000), cities('산월')],
    1306: [tech(2000), cities('남만')],
    1307: [tech(3000), cities('허창')],
    1310: [tech(2000), cities('오환')],
    91300: [tech(4000), large('한중')],
    91301: [tech(4000), large('수춘'), research('mountain')],
    91302: [tech(5000), large('남만'), research('elephant')],
    1400: [],
    1401: [tech(1000), cities('야마타이국')],
    1402: [tech(2000), cities('하비')],
    1403: [tech(3000), cities('업')],
    1500: [{ kind: 'minRelYear', min: 3 }],
    1501: [tech(1000), { kind: 'minRelYear', min: 3 }],
    1502: [tech(3000), cities('업')],
    1503: [tech(3000), cities('성도')],
    91500: [tech(5000), { kind: 'scorched', min: 1 }, { kind: 'chief' }, research('fire_wheel')],
  };
  const from = (id: number, template: number, name: string, armType: number): Unit => {
    const unit = byId.get(template);
    if (!unit) throw Error(`병종 기준 행이 없습니다: ${template}`);
    return { ...structuredClone(unit), id, name, armType };
  };
  const units = [
    ...originalUnits.filter((unit) => unit.armType !== 4),
    from(1110, 1101, '단양병', 1),
    from(1111, 1103, '청강병', 1),
    from(1112, 1103, '종인병', 1),
    from(1113, 1104, '해번병', 1),
    from(1210, 1201, '맥궁병', 2),
    from(1310, 1303, '오환돌기', 3),
    from(1400, 1100, '창극병', 4),
    from(1401, 1102, '왜모병', 4),
    from(1402, 1103, '함진영', 4),
    from(1403, 1104, '대극사', 4),
  ];
  const crewTypes = units
    .map((originalUnit): ExpandedUnit => {
      const unit = structuredClone(originalUnit);
      Object.assign(unit, balance[unit.id]);
      if (unit.id === 91102) unit.armType = 4;
      if (unit.armType > 0 && unit.armType < 5) {
        const row = affinities[unit.armType]!;
        unit.attackCoef = Object.fromEntries(row.map((value, target) => [String(target), value]));
        unit.defenceCoef = Object.fromEntries(
          row.map((value, target) => [String(target), value > 1 ? 0.8 : value < 1 ? 1.2 : 1]),
        );
      } else if (unit.armType === 5) {
        const attack = unit.attackCoef as Record<string, number>;
        const defence = unit.defenceCoef as Record<string, number>;
        unit.attackCoef = { ...attack, '4': attack['1'] ?? 1 };
        unit.defenceCoef = { ...defence, '4': defence['1'] ?? 1 };
      }
      const effects: NonNullable<Unit['effects']> = [];
      if ([0, 2].includes(unit.armType) || [1500, 1502].includes(unit.id)) effects.push('firstVolley');
      if (unit.armType === 1) effects.push('guard5');
      if (unit.armType === 3) effects.push('cavalryClash');
      if (unit.armType === 4) effects.push('pikeWall');
      if (unit.id === 1503) effects.push('hold');
      if ([1103, 1201, 1305, 91200].includes(unit.id)) effects.push('avoid');
      const requirements = conditions[unit.id];
      if (!requirements) throw Error(`승인된 병종 조건이 없습니다: ${unit.id}`);
      const reference = references[unit.id];
      const info = [
        reference
          ? `사료 근거: ${reference}. 병종 이름의 채택·수치·모집 조건은 게임 편성입니다.`
          : fictional.has(unit.id)
            ? '원작의 창작 병종입니다. 같은 부대 이름을 검토한 시대 사료 색인에서 확인하지 못했습니다.'
            : '게임의 기본 병종 또는 원작 병종입니다.',
      ];
      return {
        ...unit,
        ...(requirements.length ? { requirements } : {}),
        ...(effects.length ? { effects } : {}),
        info,
      };
    })
    .sort((a, b) => a.armType - b.armType || a.id - b.id);
  const result: ExpandedUnitSet = {
    id: 'expanded',
    name: '확장 병종',
    defaultCrewTypeId: 1100,
    armTypes: { '0': '성벽', '1': '보병', '2': '궁병', '3': '기병', '4': '창극병', '5': '차병' },
    coefMode: 'multiply',
    regionScheme: 'province-191',
    crewTypes,
  };
  const report = validateUnitSet(result);
  if (report.status !== 'pass') throw Error(`확장 병종 검증 실패: ${JSON.stringify(report.issues)}`);
  return result;
}
