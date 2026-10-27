// 전투 시뮬레이터의 요청 모양과 검사 (T4-34). 화면과 Worker가 같은 함수로 검사한다.
// 이 파일은 packages/rules를 import하지 않는다. 상한은 상수로 두고 compute.test.ts가 BALANCE와 대조한다.

export type BattleForce = { crew: number; crewType: number; train: number; atmos: number };
export type CommanderStats = { leadership: number; strength: number };
export type BattleCommanders = { attacker: CommanderStats; defender?: CommanderStats };

// simulateBattle의 BattleInput에서 unitSet을 뺀 부분. 병종표는 Worker가 자기 묶음의 공개 표를 쓴다.
export type BattleRunInput = {
  attacker: BattleForce;
  defender: BattleForce;
  attackerTech: number;
  defenderTech: number;
  defence?: number;
  commanders?: BattleCommanders;
};
export type BattleRunBody = BattleRunInput & { seed: string };
export type BattleRunRequest = BattleRunBody & { type: 'run'; requestId: number };

export type BattleRunResult = {
  type: 'result';
  requestId: number;
  seed: string;
  input: BattleRunInput;
  unitSetId: string;
  attacker: BattleForce;
  defender: BattleForce;
};
export type BattleRunErrorCode = 'INVALID_INPUT' | 'UNIT_SET_INVALID' | 'FAILED';
export type BattleRunError = { type: 'error'; requestId: number | null; code: BattleRunErrorCode; field?: string };
export type BattleRunReply = BattleRunResult | BattleRunError;

export const LIMITS = {
  // 훈련·사기 상한 (packages/rules/src/commands/effects.ts)
  STAT_MAX: 100,
  // BALANCE.MAX_TECH
  MAX_TECH: 12_000,
  // 통솔 상한 100 × BALANCE.CREW_PER_LEADERSHIP
  LEADERSHIP_MAX: 100,
  CREW_PER_LEADERSHIP: 100,
  // resources/map/che.json 도시 max.wall·max.defence의 최댓값
  WALL_MAX: 12_500,
  SEED_MAX: 64,
} as const;
export const GENERAL_CREW_MAX = LIMITS.LEADERSHIP_MAX * LIMITS.CREW_PER_LEADERSHIP;
// 실제 출병의 성벽 교전 호출 모양 (packages/rules/src/commands/attack.ts). 병종 1000, 훈련·사기 100.
export const WALL_CREW_TYPE = 1000;
export const WALL_STAT = 100;

export type Problem =
  | 'missing'
  | 'notNumber'
  | 'notInteger'
  | 'range'
  | 'unknownUnit'
  | 'wallNotAllowed'
  | 'fixed'
  | 'unexpected'
  | 'length';
export type FieldProblem = { field: string; problem: Problem; min?: number; max?: number };

export type UnitChoice = { readonly id: number; readonly armType: number };

const REQUEST_KEYS = new Set([
  'type',
  'requestId',
  'seed',
  'attacker',
  'defender',
  'attackerTech',
  'defenderTech',
  'commanders',
]);
const FORCE_KEYS = ['crew', 'crewType', 'train', 'atmos'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intProblem(value: unknown, min: number, max: number): Omit<FieldProblem, 'field'> | null {
  if (value === undefined) return { problem: 'missing' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { problem: 'notNumber' };
  if (!Number.isInteger(value)) return { problem: 'notInteger' };
  if (value < min || value > max) return { problem: 'range', min, max };
  return null;
}

export function readRequestId(message: unknown): number | null {
  if (!isRecord(message)) return null;
  const id = message.requestId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : null;
}

// 받은 값의 문제를 모두 모은다. 화면은 칸마다 이유를 보이고 Worker는 첫 문제만 답한다.
export function requestProblems(message: unknown, units: readonly UnitChoice[]): FieldProblem[] {
  if (!isRecord(message)) return [{ field: 'message', problem: 'notNumber' }];
  const problems: FieldProblem[] = [];
  const add = (field: string, found: Omit<FieldProblem, 'field'> | null) => {
    if (found) problems.push({ field, ...found });
  };
  if (message.type !== 'run') add('type', { problem: 'unexpected' });
  if (readRequestId(message) === null) add('requestId', { problem: 'notInteger' });
  for (const key of Object.keys(message)) {
    if (!REQUEST_KEYS.has(key) && key !== 'defence') add(key, { problem: 'unexpected' });
  }

  const seed = message.seed;
  if (typeof seed !== 'string') add('seed', { problem: 'missing' });
  else if (seed.length < 1 || seed.length > LIMITS.SEED_MAX)
    add('seed', { problem: 'length', min: 1, max: LIMITS.SEED_MAX });

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const force = (side: 'attacker' | 'defender') => {
    const value = message[side];
    if (!isRecord(value)) {
      add(side, { problem: 'missing' });
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!(FORCE_KEYS as readonly string[]).includes(key)) add(`${side}.${key}`, { problem: 'unexpected' });
    }
    return value;
  };

  const attacker = force('attacker');
  if (attacker) {
    const crewType = attacker.crewType;
    const typeProblem = intProblem(crewType, 1, Number.MAX_SAFE_INTEGER);
    if (typeProblem) add('attacker.crewType', typeProblem);
    else if (!unitById.has(crewType as number)) add('attacker.crewType', { problem: 'unknownUnit' });
    else if (unitById.get(crewType as number)!.armType <= 0) add('attacker.crewType', { problem: 'wallNotAllowed' });
    add('attacker.crew', intProblem(attacker.crew, 1, GENERAL_CREW_MAX));
    add('attacker.train', intProblem(attacker.train, 0, LIMITS.STAT_MAX));
    add('attacker.atmos', intProblem(attacker.atmos, 0, LIMITS.STAT_MAX));
  }

  const defender = force('defender');
  if (defender) {
    const crewType = defender.crewType;
    const typeProblem = intProblem(crewType, 1, Number.MAX_SAFE_INTEGER);
    const unit = typeProblem ? undefined : unitById.get(crewType as number);
    if (typeProblem) add('defender.crewType', typeProblem);
    else if (!unit) add('defender.crewType', { problem: 'unknownUnit' });
    else if (unit.armType <= 0 && unit.id !== WALL_CREW_TYPE) add('defender.crewType', { problem: 'wallNotAllowed' });

    if (unit && unit.id === WALL_CREW_TYPE) {
      // 성벽: 훈련·사기 100 고정, defence 필수
      add('defender.crew', intProblem(defender.crew, 1, LIMITS.WALL_MAX));
      for (const key of ['train', 'atmos'] as const) {
        const found = intProblem(defender[key], WALL_STAT, WALL_STAT);
        add(`defender.${key}`, found && found.problem === 'range' ? { problem: 'fixed', min: WALL_STAT } : found);
      }
      add('defence', intProblem(message.defence, 0, LIMITS.WALL_MAX));
    } else {
      // 장수: defence가 없어야 한다
      add('defender.crew', intProblem(defender.crew, 1, GENERAL_CREW_MAX));
      add('defender.train', intProblem(defender.train, 0, LIMITS.STAT_MAX));
      add('defender.atmos', intProblem(defender.atmos, 0, LIMITS.STAT_MAX));
      if (unit && 'defence' in message) add('defence', { problem: 'unexpected' });
    }
  }

  add('attackerTech', intProblem(message.attackerTech, 0, LIMITS.MAX_TECH));
  add('defenderTech', intProblem(message.defenderTech, 0, LIMITS.MAX_TECH));
  if ('commanders' in message) {
    const commanders = message.commanders;
    if (!isRecord(commanders)) add('commanders', { problem: 'missing' });
    else {
      const wall = defender?.crewType === WALL_CREW_TYPE;
      for (const key of Object.keys(commanders))
        if (key !== 'attacker' && key !== 'defender') add(`commanders.${key}`, { problem: 'unexpected' });
      for (const side of ['attacker', 'defender'] as const) {
        if (side === 'defender' && wall) {
          if ('defender' in commanders) add('commanders.defender', { problem: 'unexpected' });
          continue;
        }
        const stats = commanders[side];
        if (!isRecord(stats)) {
          add(`commanders.${side}`, { problem: 'missing' });
          continue;
        }
        for (const key of Object.keys(stats))
          if (key !== 'leadership' && key !== 'strength') add(`commanders.${side}.${key}`, { problem: 'unexpected' });
        for (const key of ['leadership', 'strength'] as const)
          add(`commanders.${side}.${key}`, intProblem(stats[key], 0, 100));
      }
    }
  }
  return problems;
}

export type CheckedRequest =
  { ok: true; request: BattleRunRequest } | { ok: false; requestId: number | null; field: string };

// 검사를 지난 값만 새 객체로 옮긴다. 받은 객체를 그대로 넘기지 않는다.
export function checkRequest(message: unknown, units: readonly UnitChoice[]): CheckedRequest {
  const [first] = requestProblems(message, units);
  if (first) return { ok: false, requestId: readRequestId(message), field: first.field };
  const m = message as BattleRunRequest;
  const copy = (f: BattleForce): BattleForce => ({
    crew: f.crew,
    crewType: f.crewType,
    train: f.train,
    atmos: f.atmos,
  });
  const request: BattleRunRequest = {
    type: 'run',
    requestId: m.requestId,
    seed: m.seed,
    attacker: copy(m.attacker),
    defender: copy(m.defender),
    attackerTech: m.attackerTech,
    defenderTech: m.defenderTech,
  };
  if (m.defender.crewType === WALL_CREW_TYPE) request.defence = m.defence!;
  if (m.commanders) {
    const copyStats = (stats: CommanderStats) => ({ leadership: stats.leadership, strength: stats.strength });
    request.commanders = {
      attacker: copyStats(m.commanders.attacker),
      ...(m.commanders.defender ? { defender: copyStats(m.commanders.defender) } : {}),
    };
  }
  return { ok: true, request };
}

// 화면 폼 값. 숫자 칸도 문자열로 두어 1.5·-1·빈칸 같은 입력을 그대로 검사한다.
export type ForceForm = { crew: string; crewType: string; train: string; atmos: string };
export type DefenderKind = 'general' | 'wall';
export type BattleForm = {
  statProfile: 'legacy' | 'five-stats';
  attackerCommander: { leadership: string; strength: string };
  defenderCommander: { leadership: string; strength: string };
  attacker: ForceForm;
  defender: ForceForm;
  defenderKind: DefenderKind;
  wall: string;
  defence: string;
  attackerTech: string;
  defenderTech: string;
  seed: string;
};

export function defaultForm(defaultCrewTypeId: number): BattleForm {
  const force = (): ForceForm => ({ crew: '1000', crewType: String(defaultCrewTypeId), train: '50', atmos: '50' });
  return {
    statProfile: 'legacy',
    attackerCommander: { leadership: '', strength: '' },
    defenderCommander: { leadership: '', strength: '' },
    attacker: force(),
    defender: force(),
    defenderKind: 'general',
    wall: '1000',
    defence: '0',
    attackerTech: '0',
    defenderTech: '0',
    seed: '1',
  };
}

function toNumber(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text);
}

// 폼 값을 요청 본문으로 바꾼다. 검사는 하지 않는다 (requestProblems가 한다).
export function formBody(form: BattleForm): Record<string, unknown> {
  const force = (f: ForceForm) => ({
    crew: toNumber(f.crew),
    crewType: toNumber(f.crewType),
    train: toNumber(f.train),
    atmos: toNumber(f.atmos),
  });
  const body: Record<string, unknown> = {
    seed: form.seed,
    attacker: force(form.attacker),
    defender:
      form.defenderKind === 'wall'
        ? { crew: toNumber(form.wall), crewType: WALL_CREW_TYPE, train: WALL_STAT, atmos: WALL_STAT }
        : force(form.defender),
    attackerTech: toNumber(form.attackerTech),
    defenderTech: toNumber(form.defenderTech),
  };
  if (form.defenderKind === 'wall') body.defence = toNumber(form.defence);
  if (form.statProfile === 'five-stats') {
    const commander = (stats: { leadership: string; strength: string }) => ({
      leadership: toNumber(stats.leadership),
      strength: toNumber(stats.strength),
    });
    body.commanders = {
      attacker: commander(form.attackerCommander),
      ...(form.defenderKind === 'wall' ? {} : { defender: commander(form.defenderCommander) }),
    };
  }
  return body;
}

export type FormCheck = { body: BattleRunBody; problems: [] } | { body: null; problems: FieldProblem[] };

export function checkForm(form: BattleForm, units: readonly UnitChoice[]): FormCheck {
  const message = { type: 'run', requestId: 1, ...formBody(form) };
  const checked = checkRequest(message, units);
  if (!checked.ok) return { body: null, problems: requestProblems(message, units) };
  return { body: requestBody(checked.request), problems: [] };
}

// 요청에서 type·requestId를 뺀 본문. 다시 실행할 때 이 본문을 새 번호로 보낸다.
export function requestBody(request: BattleRunRequest): BattleRunBody {
  const body: BattleRunBody = {
    seed: request.seed,
    attacker: request.attacker,
    defender: request.defender,
    attackerTech: request.attackerTech,
    defenderTech: request.defenderTech,
  };
  if (request.defence !== undefined) body.defence = request.defence;
  if (request.commanders) body.commanders = request.commanders;
  return body;
}

export function problemText(found: FieldProblem): string {
  switch (found.problem) {
    case 'missing':
      return '값을 넣어 주세요.';
    case 'notNumber':
      return '숫자로 넣어 주세요.';
    case 'notInteger':
      return '정수로 넣어 주세요.';
    case 'range':
      return `${found.min!.toLocaleString('ko-KR')}~${found.max!.toLocaleString('ko-KR')} 사이로 넣어 주세요.`;
    case 'unknownUnit':
      return '병종표에 없는 병종입니다.';
    case 'wallNotAllowed':
      return '성벽은 장수 병종으로 고를 수 없습니다.';
    case 'fixed':
      return `성벽은 ${found.min}으로 고정입니다.`;
    case 'unexpected':
      return '이 경우에는 받지 않는 값입니다.';
    case 'length':
      return `${found.min}~${found.max}자로 넣어 주세요.`;
  }
}
