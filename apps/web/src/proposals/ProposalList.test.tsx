// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProposalList, type ProposalItem } from './ProposalList';

afterEach(cleanup);

const item = (over: Partial<ProposalItem> = {}): ProposalItem => ({
  id: 'p1',
  proposer: { id: 7, name: '조운', portraitId: null, officerTitle: '편장군' },
  commandKey: 'nation_declare',
  commandName: '선전포고',
  argsSummary: '동탁에게',
  slot: 3,
  note: '낙양을 지키려면 먼저 쳐야 합니다.',
  status: 'open',
  createdTick: 100,
  expiresTick: 112,
  precheck: { ok: false, message: '이미 전쟁 중인 국가입니다.' },
  response: null,
  ...over,
});

describe('D-100 명령 제안 목록', () => {
  it('받은 제안은 칸을 정해 승인하거나 사유를 적어 거절한다', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ProposalList box="received" items={[item()]} nowTick={104} onApprove={onApprove} onReject={onReject} />);
    const box = screen.getByRole('region', { name: '받은 명령 제안' });
    expect(within(box).getByText('8턴 뒤 만료')).toBeTruthy();
    expect(within(box).getByRole('note').textContent).toContain('이미 전쟁 중인 국가입니다.');
    fireEvent.change(within(box).getByRole('spinbutton', { name: '국가 예턴 칸' }), { target: { value: '5' } });
    fireEvent.click(within(box).getByRole('button', { name: '5번 칸에 승인' }));
    expect(onApprove).toHaveBeenCalledWith('p1', 5);
    fireEvent.click(within(box).getByRole('button', { name: '거절' }));
    fireEvent.change(within(box).getByRole('textbox', { name: '거절 사유' }), { target: { value: ' 아직 이르다 ' } });
    fireEvent.click(within(box).getByRole('button', { name: '거절 보내기' }));
    expect(onReject).toHaveBeenCalledWith('p1', '아직 이르다');
  });

  it('보낸 제안은 상태와 답을 보이고 기다리는 제안만 거둔다', () => {
    const onCancel = vi.fn();
    render(
      <ProposalList
        box="sent"
        nowTick={104}
        onCancel={onCancel}
        items={[
          item(),
          item({ id: 'p2', status: 'rejected', response: { by: '조조', at: 103, reason: '군량이 모자라다' } }),
        ]}
      />,
    );
    expect(screen.getByText('거절됨 · 조조')).toBeTruthy();
    expect(screen.getByText('“군량이 모자라다”')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: '제안 거두기' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onCancel).toHaveBeenCalledWith('p1');
  });

  it('비어 있으면 안내를 보인다', () => {
    render(<ProposalList box="received" items={[]} nowTick={0} />);
    expect(screen.getByText('받은 제안이 없습니다.')).toBeTruthy();
  });
});
