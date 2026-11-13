// 예턴 칸 요약. 원작(core2026 reservedCommandBrief.ts, Ref getBrief)의 문장 규칙을 우리 명령 키와 인자 이름에 맞춘다.
// 예: 【낙양】으로 이동, 【업】에 화계실행, 【조조】를 등용, 【창병】 1000명 모병, 군량 500을 구입.
// 규칙이 없는 명령은 명령 이름만 적는다. 대상 이름을 모르면 지금까지 쓰던 대체 글(도시 N·국가 N·장수 N)을 괄호 안에 쓴다.
import { particle, type Josa } from '../game/josa';
import { commandName as defaultCommandName, displayName } from '../game/names';
import type { ArgNames } from './args';

const wrap = (value: string) => `【${value}】`;
const wrapWith = (value: string, pair: Josa) => `${wrap(value)}${particle(value, pair)}`;

// 도시로 가는 명령 (원작 이동·강행·출병·천도).
const CITY_TO = new Set(['move', 'attack', 'nation_capital']);
// 도시에 거는 명령 (원작 첩보·화계·선동·탈취·파괴·백성동원). 개인 계략은 `…실행`, 첩보는 띄어 `첩보 실행`, 국가 명령은 이름만 붙인다.
const CITY_AT = new Set(['spy', 'fire_attack', 'sabotage', 'incite', 'plunder', 'nation_mobilize']);
// 국가에 거는 명령 (원작 선전포고·급습·이호경식).
const NATION_AT = new Set(['nation_declare', 'nation_raid', 'nation_rivalry']);
// 국가에 보내는 제의 (원작 불가침 파기 제의·종전 제의). 우리 불가침 제의는 기한 인자가 없어 같은 꼴로 적는다.
const NATION_PROPOSAL = new Set(['nation_peace', 'nation_pact', 'nation_break_pact']);
const SLOT_NAMES: Record<string, string> = { horse: '명마', weapon: '무기', book: '서적', item: '도구' };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const plain = (value: number) => String(value);
const grouped = (value: number) => value.toLocaleString('en-US');
const resourceName = (value: unknown) => (value === 'rice' ? '쌀' : '금');

export function reservedBrief(
  commandKey: string,
  args: Record<string, unknown>,
  names: ArgNames,
  name: string = defaultCommandName(commandKey),
): string {
  const cityKey = num(args.cityKey);
  const nationId = num(args.nationId);
  const generalId = num(args.generalId);
  const amount = num(args.amount);
  const city = cityKey === null ? null : (names.city(cityKey) ?? `도시 ${cityKey}`);
  const nation = nationId === null ? null : (names.nation(nationId) ?? `국가 ${nationId}`);
  const general = generalId === null ? null : displayName(names.general?.(generalId) ?? `장수 ${generalId}`);
  const nationScope = commandKey.startsWith('nation_');

  if (CITY_TO.has(commandKey) && city) return `${wrapWith(city, '으로/로')} ${name}`;
  if (CITY_AT.has(commandKey) && city) {
    const suffix = nationScope ? name : commandKey === 'spy' ? `${name} 실행` : `${name}실행`;
    return `${wrap(city)}에 ${suffix}`;
  }
  // 교역은 원작에 없는 우리 명령이다. 대상 도시를 잃지 않게 `【양양】과 교역`으로 적는다.
  if (commandKey === 'trade' && city) return `${wrapWith(city, '와/과')} ${name}`;
  if (commandKey === 'join' && nation) return `${wrapWith(nation, '으로/로')} ${name}`;
  if (commandKey === 'join_random') return '무작위 국가로 임관';
  if (NATION_AT.has(commandKey) && nation) return `${wrap(nation)}에 ${name}`;
  if (NATION_PROPOSAL.has(commandKey) && nation) return `${wrap(nation)}에게 ${name}`;
  // 원작 물자 원조는 국고·병량을 함께 보내고, 우리 원조는 한 자원만 보낸다. 금은 국고, 쌀은 병량으로 적는다.
  if (commandKey === 'nation_aid' && nation) {
    if (amount === null) return `${wrap(nation)}에게 ${name}`;
    return `${wrap(nation)}에게 ${args.resource === 'rice' ? '병량' : '국고'} ${grouped(amount)} ${name}`;
  }
  if (commandKey === 'invite' && general) return `${wrapWith(general, '을/를')} ${name}`;
  if (commandKey === 'abdicate' && general) return `${wrap(general)}에게 ${name}`;
  if (commandKey === 'found' && typeof args.name === 'string') return `${wrapWith(args.name, '을/를')} 건국`;
  // 거병도 원작에는 인자가 없지만 우리는 나라 이름을 받는다. 건국과 같은 꼴로 이름을 남긴다.
  if (commandKey === 'uprising' && typeof args.name === 'string') return `${wrapWith(args.name, '으로/로')} ${name}`;
  if (commandKey === 'trade_rice' && amount !== null) return `군량 ${plain(amount)}을 ${args.buy ? '구입' : '판매'}`;
  if (commandKey === 'donate' && amount !== null) return `${resourceName(args.resource)} ${plain(amount)}을 ${name}`;
  if ((commandKey === 'recruit' || commandKey === 'conscript') && amount !== null) {
    const crewType = num(args.crewType);
    if (crewType === null) return `${plain(amount)}명 ${name}`;
    return `${wrap(names.unit?.(crewType) ?? `병종 ${crewType}`)} ${plain(amount)}명 ${name}`;
  }
  if (commandKey === 'equipment_trade' && typeof args.itemKey === 'string') {
    if (args.itemKey === 'none') {
      const slot = typeof args.slot === 'string' ? SLOT_NAMES[args.slot] : undefined;
      // 원작 문구 그대로 판매 뒤에 마침표가 붙는다.
      if (slot) return `${wrapWith(slot, '을/를')} 판매.`;
    } else {
      const item = names.equipment?.(args.itemKey) ?? `장비 ${args.itemKey}`;
      return `${wrapWith(item, '을/를')} 구입`;
    }
  }
  if (commandKey === 'nation_assign' && general && city) return `${wrap(general)}${wrapWith(city, '으로/로')} ${name}`;
  if ((commandKey === 'nation_reward' || commandKey === 'nation_seize') && general && amount !== null)
    return `${wrap(general)} ${resourceName(args.resource)} ${grouped(amount)} ${name}`;
  return name;
}
