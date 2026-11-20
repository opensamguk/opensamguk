// @vitest-environment jsdom
// 성 규모 판(INT-30, D-109): 국가 명령 증축, 감축 안내, 감축 철거 확인, 국가 예턴 연속 다섯 칸.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CityLand, LandUpgrade } from './CityScene';
import { editableTab, planScaleSlots, reserveScale } from './nationScale';
import { UpgradePanel } from './UpgradePanel';
import type { NationTurnTab } from '../personnel/contract';

const upgrade = (over: Partial<LandUpgrade> = {}): LandUpgrade => ({
  enabled: true,
  isChief: true,
  turns: 5,
  expand: { nextLevel: 6, nextGrade: '중', cost: 110000, canStart: true, failure: null },
  shrink: {
    previousLevel: 2,
    previousGrade: '현',
    refund: 80000,
    canStart: true,
    failure: null,
    demolished: [{ slotId: '2.5,2.5', building: 'farm' }],
  },
  preparing: [],
  ...over,
});
const land = (up: LandUpgrade | null): CityLand => ({
  cityKey: 96,
  grade: '소',
  core: 2,
  slots: [],
  buildings: [{ key: 'farm', name: '농지' } as CityLand['buildings'][number]],
  upgrade: up,
});

afterEach(cleanup);

describe('UpgradePanel', () => {
  it('증축을 누르면 nation_expand를 넣는다', async () => {
    const reserve = vi.fn(async () => ({ ok: true as const, slot: 3 }));
    render(<UpgradePanel land={land(upgrade())} onReserve={reserve} nationTurnsHref="/w/x/nation/turns" />);
    expect(screen.getByText(/소 → 중, 국고 금 110,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '증축을 국가 예턴에 넣기' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('4~8번째 칸'));
    expect(reserve).toHaveBeenCalledWith('nation_expand');
    expect(screen.getByRole('link', { name: '국가 예턴 열기' }).getAttribute('href')).toBe('/w/x/nation/turns');
  });

  it('감축은 철거될 건물을 보이고 한 번 더 눌러야 넣는다', async () => {
    const reserve = vi.fn(async () => ({ ok: true as const, slot: 0 }));
    render(<UpgradePanel land={land(upgrade())} onReserve={reserve} />);
    expect(screen.getByText(/환급 없이 철거: 농지\(2\.5,2\.5\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '감축을 국가 예턴에 넣기' }));
    expect(reserve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '철거를 확인하고 넣기' }));
    await waitFor(() => expect(reserve).toHaveBeenCalledWith('nation_shrink'));
  });

  it('수뇌가 아니거나 거부되면 단추를 막고 이유를 보인다', () => {
    const up = upgrade({ isChief: false });
    up.expand = { ...up.expand, canStart: false, failure: { code: 'NO_GOLD', message: '국고 금이 부족합니다.' } };
    render(<UpgradePanel land={land(up)} onReserve={async () => ({ ok: true, slot: 0 })} />);
    expect(screen.getByText('국고 금이 부족합니다.')).toBeTruthy();
    expect(screen.getByText('증축과 감축은 수뇌만 넣을 수 있습니다.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '증축을 국가 예턴에 넣기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('준비 중이면 남은 실행 수를 보인다', () => {
    render(
      <UpgradePanel
        land={land(upgrade({ preparing: [{ commandKey: 'nation_expand', officerLevel: 12, remainingTurns: 3 }] }))}
      />,
    );
    expect(screen.getByText(/증축 준비 중\(군주\), 남은 실행 3번/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '증축 준비 중' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('기능이 꺼졌거나 할 것이 없으면 그리지 않는다', () => {
    const { container, rerender } = render(<UpgradePanel land={land(upgrade({ enabled: false }))} />);
    expect(container.innerHTML).toBe('');
    const none = upgrade();
    none.expand = { ...none.expand, nextGrade: null, nextLevel: null };
    none.shrink = { ...none.shrink, previousGrade: null, previousLevel: null };
    rerender(<UpgradePanel land={land(none)} />);
    expect(container.innerHTML).toBe('');
    rerender(<UpgradePanel land={land(null)} />);
    expect(container.innerHTML).toBe('');
  });
});

const slot = (commandKey: string, args?: unknown) => ({ commandKey, args, name: commandKey });
const rest = () => slot('nation_rest');
const tab = (over: Partial<NationTurnTab> = {}): NationTurnTab => ({
  office: { nationId: 7, officerLevel: 12, tenure: 1 },
  officerLevel: 12,
  title: '군주',
  holder: { generalId: 492, name: '시험' },
  edit: { ok: true },
  revision: 4,
  slots: Array.from({ length: 12 }, rest),
  ...over,
});

describe('nationScale', () => {
  it('처음 나오는 연속 빈 칸 다섯에 넣고 나머지 칸은 그대로 둔다', () => {
    const slots = [
      slot('nation_research', { kind: 'a' }),
      rest(),
      rest(),
      slot('x'),
      ...Array.from({ length: 8 }, rest),
    ];
    const plan = planScaleSlots(slots, 'nation_expand', 96)!;
    expect(plan.from).toBe(4);
    expect(plan.slots[0]).toEqual({ commandKey: 'nation_research', args: { kind: 'a' } });
    expect(plan.slots[1]).toBeNull();
    expect(plan.slots.slice(4, 9)).toEqual(Array(5).fill({ commandKey: 'nation_expand', args: { cityKey: 96 } }));
    expect(plan.slots[9]).toBeNull();
  });

  it('연속 빈 칸 다섯이 없으면 넣지 않는다', () => {
    const slots = Array.from({ length: 12 }, (_, n) => (n % 4 === 3 ? slot('x') : rest()));
    expect(planScaleSlots(slots, 'nation_shrink', 96)).toBeNull();
  });

  it('고칠 수 있는 직책 탭 가운데 높은 직책을 고르고 12칸을 저장한다', async () => {
    const tabs = [tab({ officerLevel: 5, office: { nationId: 7, officerLevel: 5, tenure: 2 } }), tab()];
    const setNationTurns = vi.fn(async () => ({ ok: true as const, revision: 5, slots: [] }));
    const result = await reserveScale(
      { nationTurns: async () => ({ actorId: 492, tabs }), setNationTurns },
      'w1',
      'nation_expand',
      96,
    );
    expect(editableTab(tabs)?.officerLevel).toBe(12);
    expect(result).toEqual({ ok: true, slot: 0 });
    expect(setNationTurns).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: 'w1', revision: 4, expectedActorId: 492, office: tabs[1]!.office }),
    );
  });

  it('고칠 수 있는 직책이 없거나 저장이 엇갈리면 알린다', async () => {
    const readOnly = await reserveScale(
      {
        nationTurns: async () => ({ actorId: 1, tabs: [tab({ edit: { ok: false, reason: '남의 칸' } })] }),
        setNationTurns: vi.fn(),
      },
      'w1',
      'nation_expand',
      96,
    );
    expect(readOnly.ok).toBe(false);
    const stale = await reserveScale(
      {
        nationTurns: async () => ({ actorId: 1, tabs: [tab()] }),
        setNationTurns: async () => ({ ok: false as const, reason: 'STALE' as const, revision: 9, slots: [] }),
      },
      'w1',
      'nation_expand',
      96,
    );
    expect(stale).toEqual({ ok: false, message: '그 사이 국가 예턴이 바뀌었습니다. 다시 눌러 주세요.' });
  });
});
