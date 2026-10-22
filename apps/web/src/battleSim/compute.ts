// E1 (docs/architecture/package-boundaries.md): apps/web에서 @opensamguk/rules 값을 import하는 파일은
// 이 파일과 compute.test.ts뿐이다. battle.worker.ts만 이 파일을 import하므로 simulateBattle은 Worker 묶음에만 들어간다.
import { simulateBattle, unitSetSchema, type UnitSetResource } from '@opensamguk/rules';
import { createRng } from '@opensamguk/shared';
import { checkRequest, readRequestId, requestBody, type BattleRunInput, type BattleRunReply } from './request';

// 병종표를 엔진의 buildInitialWorld와 같은 기준으로 검사한다: schema, id 중복, 기본 병종 존재.
function parseUnitSet(raw: unknown): UnitSetResource | null {
  const parsed = unitSetSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ids = new Set(parsed.data.crewTypes.map((unit) => unit.id));
  if (ids.size !== parsed.data.crewTypes.length || !ids.has(parsed.data.defaultCrewTypeId)) return null;
  return parsed.data;
}

// 병종표를 인자로 받아 오류 경로를 시험할 수 있게 한다. 병종표 검사는 처음 한 번만 한다.
export function createCompute(rawUnitSet: unknown): (message: unknown) => BattleRunReply {
  const unitSet = parseUnitSet(rawUnitSet);
  return (message) => {
    if (!unitSet) return { type: 'error', requestId: readRequestId(message), code: 'UNIT_SET_INVALID' };
    const checked = checkRequest(message, unitSet.crewTypes);
    if (!checked.ok) {
      return { type: 'error', requestId: checked.requestId, code: 'INVALID_INPUT', field: checked.field };
    }
    const { seed, ...input } = requestBody(checked.request);
    const result = simulateBattle({ ...input, unitSet }, createRng(seed));
    const echoed: BattleRunInput = input;
    return {
      type: 'result',
      requestId: checked.request.requestId,
      seed,
      input: echoed,
      unitSetId: unitSet.id,
      attacker: result.attacker,
      defender: result.defender,
    };
  };
}
