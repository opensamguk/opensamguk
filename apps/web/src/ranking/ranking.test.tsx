// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RankingView } from './RankingPage';
import { GeneralRankingTable, NationRankingTable } from './RankingTables';
import {
  defaultSearch,
  formatAt,
  parseRankingSearch,
  rankTone,
  type RankedGeneral,
  type RankedNation,
} from './rankingView';

afterEach(cleanup);

// T2-23 · AC-M2-19 (화면). 자료는 순위 API 응답 타입(AppRouter)에 맞춘 고정값이다. 실제 자료 검증은 e2e/ranking.spec.ts에서 한다.
const wei = { id: 1, name: '위', color: '#2f5f9e' };
const general = (rank: number, generalId: number, name: string, nation = wei): RankedGeneral => ({
  rank,
  generalId,
  portraitId: null,
  isHuman: true,
  name,
  nation,
  dedication: 1000 - rank,
  experience: 500 - rank,
  wins: 6 - rank,
  captures: 4,
  merit: 10 - rank,
  stratagemSuccesses: 0,
  battleStats: null,
  value: 1000 - rank,
});
const at = { tick: 30000, year: 193, month: 4 };
const tab = (t: string, label: string, active: boolean) => (
  <span key={t} data-active={active}>
    {label}
  </span>
);

describe('주소 해석', () => {
  it('기본은 장수 탭의 공헌', () => {
    expect(parseRankingSearch({})).toEqual({ tab: 'generals', by: 'dedication' });
  });
  it('탭에 맞지 않는 기준은 그 탭의 첫 기준으로 돌린다', () => {
    expect(parseRankingSearch({ tab: 'generals', by: 'cities' })).toEqual({ tab: 'generals', by: 'dedication' });
    expect(parseRankingSearch({ tab: 'nations', by: 'merit' })).toEqual({ tab: 'nations', by: 'cities' });
    expect(parseRankingSearch({ tab: 'nations', by: 'power' })).toEqual({ tab: 'nations', by: 'power' });
    expect(parseRankingSearch({ tab: 'x', by: 'experience' })).toEqual({ tab: 'generals', by: 'experience' });
  });
  it('장수 종류는 장수 순위 주소에서만 해석한다', () => {
    expect(parseRankingSearch({ tab: 'generals', by: 'wins', kind: 'npc' })).toEqual({
      tab: 'generals',
      by: 'dedication',
      kind: 'npc',
    });
    expect(parseRankingSearch({ tab: 'nations', kind: 'npc' })).toEqual({ tab: 'nations', by: 'cities' });
  });
  it('탭을 바꾸면 첫 기준부터', () => {
    expect(defaultSearch('nations')).toEqual({ tab: 'nations', by: 'cities' });
  });
});

describe('표시 도우미', () => {
  it('1~3위만 배지 색이 있다', () => {
    expect([1, 2, 3, 4].map(rankTone)).toEqual(['gold', 'jade', 'muted', null]);
  });
  it('기준 시각', () => {
    expect(formatAt(at)).toBe('193년 4월 정산 기준');
    expect(formatAt(null)).toBe('아직 월간 정산 전이라 순위가 없습니다');
  });
});

describe('장수 순위 표', () => {
  it('받은 순서대로 그리고 숫자는 천 단위로 끊는다', () => {
    const top = [general(1, 7, '조조'), general(2, 3, '유비', { id: 2, name: '촉', color: '#2e7d4f' })];
    render(<GeneralRankingTable ranking={{ top, me: null, at }} by="dedication" onSort={() => {}} />);
    const rows = within(screen.getByRole('table', { name: '장수 순위' })).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('조조');
    expect(rows[2]?.textContent).toContain('유비');
    expect(screen.getByText('999')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '내 순위로' })).toBeNull();
  });

  it('INT-25 이름은 괄호를 빼고 행마다 20×28 thumb 얼굴을 둔다', () => {
    const top = [{ ...general(1, 7, '조조(曹操)'), portraitId: 10006 }, general(2, 3, '유비')];
    const { container } = render(
      <GeneralRankingTable ranking={{ top, me: null, at }} by="dedication" onSort={() => {}} />,
    );
    expect(screen.getByText('조조')).toBeTruthy();
    expect(screen.queryByText('조조(曹操)')).toBeNull();
    const faces = container.querySelectorAll('[data-variant="thumb"]');
    expect(faces).toHaveLength(2);
    expect((faces[0] as HTMLElement).style.width).toBe('20px');
    expect((faces[0] as HTMLElement).style.height).toBe('28px');
    expect(faces[0]?.getAttribute('data-state')).toBe('image');
    expect(faces[1]?.getAttribute('data-state')).toBe('fallback');
  });

  // 원작 명장일람처럼 전공 옆에 승리·점령을 나눠 쓰고 이름의 괄호는 뺀다 (INT-25).
  it('전공 옆에 승리·점령 열을 따로 두고 이름 괄호를 뺀다', () => {
    const top = [general(1, 7, '조조(曹操)')];
    render(<GeneralRankingTable ranking={{ top, me: null, at }} by="merit" onSort={() => {}} />);
    const table = screen.getByRole('table', { name: '장수 순위' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers.slice(-2)).toEqual(['승리', '점령']);
    const cells = within(table).getAllByRole('row')[1]!.children;
    expect(cells[1]?.textContent).toBe('조조');
    expect(
      Array.from(cells)
        .slice(-2)
        .map((cell) => cell.textContent),
    ).toEqual(['5', '4']);
  });

  it('재야는 소속이 재야로 나온다', () => {
    const top = [{ ...general(1, 9, '여포'), nation: null }];
    render(<GeneralRankingTable ranking={{ top, me: null, at }} by="dedication" onSort={() => {}} />);
    expect(screen.getByText('재야')).toBeTruthy();
  });

  it('내 장수는 강조하고 「나」를 붙이며 내 순위로 이동한다', () => {
    const me = general(2, 3, '유비');
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <GeneralRankingTable ranking={{ top: [general(1, 7, '조조'), me], me, at }} by="dedication" onSort={() => {}} />,
    );
    const row = screen.getByText('유비').closest('tr');
    expect(row?.getAttribute('data-me')).toBe('true');
    expect(within(row as HTMLElement).getByText('나')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '내 순위로' }));
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(row);
  });

  it('상위 목록 밖이면 표 끝에 따로 한 줄', () => {
    const me = general(250, 42, '장비');
    render(
      <GeneralRankingTable ranking={{ top: [general(1, 7, '조조')], me, at }} by="dedication" onSort={() => {}} />,
    );
    const rows = within(screen.getByRole('table', { name: '장수 순위' })).getAllByRole('row');
    const last = rows.at(-1);
    expect(last?.textContent).toContain('250');
    expect(last?.textContent).toContain('장비');
    expect(last?.getAttribute('data-me')).toBe('true');
    expect(screen.getByRole('button', { name: '내 순위로' })).toBeTruthy();
  });

  it('머리글을 누르면 기준이 바뀌고 지금 기준은 aria-sort로 알린다', () => {
    const onSort = vi.fn();
    render(
      <GeneralRankingTable ranking={{ top: [general(1, 7, '조조')], me: null, at }} by="experience" onSort={onSort} />,
    );
    expect(screen.getByRole('columnheader', { name: /경험/ }).getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('columnheader', { name: /공헌/ }).getAttribute('aria-sort')).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: /전공/ }));
    expect(onSort).toHaveBeenCalledWith('merit');
  });
});

describe('국가 순위 표', () => {
  it('국가·도시·장수·국력만 있고 국고·군량 열은 없다', () => {
    const items: RankedNation[] = [
      {
        rank: 1,
        nationId: 1,
        name: '위',
        color: '#2f5f9e',
        philosophy: null,
        cities: 12,
        generals: 30,
        power: 4321,
        value: 12,
        forceEstimate: {
          totalGeneralCount: 30,
          userCombatGeneralCount: 1,
          userTroops: 9000,
          npcCombatGeneralCount: 2,
          npcTroops: 15000,
          inactiveGeneralCount: 3,
        },
      },
    ];
    render(<NationRankingTable ranking={{ items, at }} by="cities" onSort={() => {}} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['순위', '국가', '도시▼', '장수', '국력']);
    expect(screen.queryByText(/국고|군량|금|쌀/)).toBeNull();
    expect(screen.getByText('4,321')).toBeTruthy();
    fireEvent.click(screen.getByText('현재 병력 추정'));
    expect(screen.getByText('1명 · 약 9,000명')).toBeTruthy();
    expect(screen.getByText('2명 · 약 15,000명')).toBeTruthy();
  });
});

describe('화면 상태', () => {
  it('불러오는 동안 상태를 알린다', () => {
    render(
      <RankingView search={defaultSearch('generals')} data={{ state: 'loading' }} onSort={() => {}} renderTab={tab} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: '순위' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('순위를 불러오는 중…');
  });

  it('정산 전이면 순위가 없다고 알린다', () => {
    render(
      <RankingView
        search={defaultSearch('nations')}
        data={{ state: 'ready', tab: 'nations', ranking: { items: [], at: null } }}
        onSort={() => {}}
        renderTab={tab}
      />,
    );
    expect(screen.getByText('아직 월간 정산 전이라 순위가 없습니다')).toBeTruthy();
  });

  it('불러오기 실패는 다시 시도를 준다', () => {
    const retry = vi.fn();
    render(
      <RankingView
        search={defaultSearch('generals')}
        data={{ state: 'error', retry }}
        onSort={() => {}}
        renderTab={tab}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('기준 시각은 자료가 있을 때 제목 옆에 나온다', () => {
    render(
      <RankingView
        search={defaultSearch('generals')}
        data={{ state: 'ready', tab: 'generals', ranking: { top: [general(1, 7, '조조')], me: null, at } }}
        onSort={() => {}}
        renderTab={tab}
      />,
    );
    expect(screen.getByText('193년 4월 정산 기준')).toBeTruthy();
    expect(screen.getByRole('table', { name: '장수 순위' })).toBeTruthy();
  });
});
