// 지도 편집기 검증 목록 (docs/plans/T4-80.md, docs/plans/T4-88.md). 판단은 공개 validateMap(@opensamguk/rules/resources)이
// 정본이고, 여기서는 그 보고를 화면 문구·심각도·선택 대상으로만 바꾼다. 검사를 다시 하지 않는다.
// 게시를 막는 판단은 서버가 한다. 시나리오가 참조하는 도시 검사는 편집기에 시나리오가 없어 넘기지 않는다.
import {
  validateMap,
  type MapResource,
  type ResourceIssue,
  type ResourceIssueCode,
  type Severity,
  type ValidationReport,
} from '@opensamguk/rules/resources';
import { josa } from './josa';
import { layerLabel, type MapV2, type TerrainLayer } from './contract';

// 도시는 목록 번호로 가리킨다. 불러온 파일에는 ID가 겹치는 도시가 있을 수 있어서다. 가리킬 곳이 없으면 null이다.
export type IssueTarget =
  { kind: 'city'; index: number } | { kind: 'terrain'; layer: TerrainLayer; index: number } | null;
export interface Issue {
  code: ResourceIssueCode;
  severity: Severity;
  message: string;
  target: IssueTarget;
}

const LAYERS: readonly string[] = ['coast', 'lakes', 'mountains', 'rivers'] satisfies TerrainLayer[];

function editorTarget(issue: ResourceIssue): IssueTarget {
  const target = issue.target;
  if (target.kind === 'city') return { kind: 'city', index: target.index };
  if (target.kind === 'terrain') return { kind: 'terrain', layer: target.layer, index: target.index };
  if (target.kind !== 'path') return null;
  const [head, first, second] = target.path;
  if (head === 'cities' && typeof first === 'number') return { kind: 'city', index: first };
  if (head === 'terrain' && typeof first === 'string' && LAYERS.includes(first) && typeof second === 'number')
    return { kind: 'terrain', layer: first as TerrainLayer, index: second };
  return null;
}

// rules params와 지도만으로 기존 조사 문장을 만들 수 있는 코드만 바꾸고, 나머지는 rules 문구를 그대로 쓴다.
function editorMessage(issue: ResourceIssue, target: IssueTarget, map: MapV2): string {
  const { width, height } = map.canvas;
  const { params } = issue;
  if (target?.kind === 'terrain') {
    const name = `${layerLabel(target.layer)} ${target.index + 1}`;
    switch (issue.code) {
      case 'terrain-open':
        return target.layer === 'rivers'
          ? `${name}의 점이 ${params.count}개라서 선이 되지 않습니다.`
          : `${josa(name, '은/는')} 닫히지 않은 다각형입니다.`;
      case 'terrain-out-of-canvas':
        return `${name}의 점 ${params.outsideCount}개가 캔버스 ${width}×${height} 밖입니다.`;
      default:
        return issue.message;
    }
  }
  if (target?.kind !== 'city' || issue.target.kind !== 'city') return issue.message;
  const index = target.index;
  const city = map.cities[index]!;
  const label = (i: number) => map.cities[i]!.name || `ID ${map.cities[i]!.id}`;
  const indexOfId = (id: number) => map.cities.findIndex((other) => other.id === id);
  switch (issue.code) {
    case 'city-id-duplicate':
      return `도시 ID ${city.id}를 ${josa(label(Number(params.firstIndex)), '와/과')} ${josa(label(index), '이/가')} 같이 씁니다.`;
    case 'city-name-empty':
      return `ID ${city.id} 도시의 이름이 비었습니다.`;
    case 'city-name-duplicate':
      return `도시 이름 ${josa(String(params.name), '이/가')} ID ${josa(String(map.cities[Number(params.firstIndex)]!.id), '와/과')} ID ${city.id}에 겹칩니다.`;
    case 'city-out-of-canvas':
      return `${label(index)}의 좌표 (${city.position.x}, ${city.position.y})는 캔버스 ${width}×${height} 밖입니다.`;
    case 'link-self':
      return `${josa(label(index), '이/가')} 자기 자신과 이어져 있습니다.`;
    case 'link-missing-city':
      return `${josa(label(index), '이/가')} 없는 도시 ID ${josa(String(params.cityId), '와/과')} 이어져 있습니다.`;
    case 'link-one-way':
      return `${label(index)}에서 ${josa(label(indexOfId(Number(params.cityId))), '으로/로')} 가는 연결만 있고 돌아오는 연결이 없습니다.`;
    case 'network-split':
      return `${josa(label(index), '이/가')} ${label(0)}의 연결망에 닿지 않습니다.`;
    default:
      return issue.message;
  }
}

export function toEditorIssues(report: ValidationReport<MapResource>, map: MapV2): Issue[] {
  return report.issues.map((issue) => {
    const target = editorTarget(issue);
    return { code: issue.code, severity: issue.severity, message: editorMessage(issue, target, map), target };
  });
}

export const editorIssues = (map: MapV2): Issue[] => toEditorIssues(validateMap(map), map);
