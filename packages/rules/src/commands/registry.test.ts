import { describe, expect, it } from 'vitest';
import { commands, commandRegistry } from './registry';
import { commandCases } from './contracts';
import { militaryCommands } from './military';
import { personnelCommands } from './personnel';
import { personalCommands } from './personal';
import { nationCommands } from './nation';
import { attack } from './attack';

describe('AC-M1-14 명령 자동 대조', () => {
  it('37개 key, 장수27·국가10과 행동 검사 목록이 정확히 일치한다', () => {
    expect(commands).toHaveLength(37);
    expect(commandRegistry.size).toBe(37);
    expect(commands.filter((c) => c.target === 'general')).toHaveLength(27);
    expect(commands.filter((c) => c.target === 'nation')).toHaveLength(10);
    expect(Object.keys(commandCases).sort()).toEqual(commands.map((c) => c.key).sort());
  });
  it('신규28개 category는 target과 별도로 지정한다', () => {
    for (const [group, category] of [
      [militaryCommands, 'military'],
      [[attack], 'military'],
      [personnelCommands, 'strategy'],
      [personalCommands, 'personal'],
      [nationCommands, 'nation'],
    ] as const) {
      for (const command of group) expect(command).toHaveProperty('category', category);
    }
  });
});
