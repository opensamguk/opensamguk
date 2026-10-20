import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextActions, parseQueue, render } from './next-task.mjs';

const table = (rows: string) => `| ID | 작업 | AC | 구현 | 선행 | 단계 |\n| -- | -- | -- | -- | -- | -- |\n${rows}`;

describe('다음 작업 출력', () => {
  it('진행중 작업은 다른 구현 대기보다 먼저 표시한다', () => {
    const rows = parseQueue(table('| T1-01 | 대기 | M1-01 | Codex | — | 구현 |\n| T1-02 | 착수 | M1-02 | Codex | — | 진행중 |'));
    const result = nextActions(rows);
    expect(result.ready.Codex?.[0]).toMatchObject({ what: '진행중', row: { id: 'T1-02' } });
    expect(render(result)).toContain('[Codex] 진행중 T1-02');
  });

  it('담당별 동시 진행중 두 건은 거부한다', () => {
    expect(() => parseQueue(table('| T1-01 | 하나 | M1-01 | Codex | — | 진행중 |\n| T1-02 | 둘 | M1-02 | Codex | — | 진행중 |'))).toThrow('한 번에 하나');
  });
  it('구현이 끝난 작업의 리뷰는 반대쪽이 맡는다', () => {
    const rows = parseQueue(
      table('| T1-01 | 백엔드 | M1-01 | Codex | — | 리뷰 |\n| T1-02 | 화면 | M1-02 | Claude | — | 리뷰 |'),
    );
    const { ready } = nextActions(rows);
    expect(ready.Claude?.[0]).toMatchObject({ what: '리뷰', row: { id: 'T1-01' } });
    expect(ready.Codex?.[0]).toMatchObject({ what: '리뷰', row: { id: 'T1-02' } });
  });

  it('계획은 항상 Claude가 맡고 선행과 상관없이 할 수 있다', () => {
    const rows = parseQueue(table('| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |\n| T1-02 | 월드 | M1-02 | Codex | T1-01 | 계획 |'));
    const { ready } = nextActions(rows);
    expect(ready.Claude?.[0]).toMatchObject({ what: '계획', row: { id: 'T1-02' } });
    expect(ready.Codex?.[0]).toMatchObject({ what: '구현', row: { id: 'T1-01' } });
  });

  it('선행이 끝나지 않은 구현은 대기로 둔다', () => {
    const rows = parseQueue(table('| T1-01 | 뼈대 | M1-01 | Codex | — | 리뷰 |\n| T1-02 | 화면 | M1-02 | Claude | T1-01 | 구현 |'));
    const { ready, blocked } = nextActions(rows);
    expect(ready.Claude?.map((i) => i.row.id)).toEqual(['T1-01']);
    expect(blocked.map((b) => b.row.id)).toEqual(['T1-02']);
  });

  it('현재 관문이 끝나야 다음 관문 작업이 나온다', () => {
    const rows = parseQueue(
      table('| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 구현 |\n| T2-02 | 로비 | M2-02 | Claude | T2-01~T2-01 | 구현 |'),
    );
    const result = nextActions(rows);
    expect(result.milestone).toBe(2);
    expect(result.ready.Codex?.[0]?.row.id).toBe('T2-01');
    expect(result.blocked.map((b) => b.row.id)).toEqual(['T2-02']);
  });

  it('구현 단계여도 계획 문서가 없으면 Claude가 먼저 계획한다', () => {
    const rows = parseQueue(table('| T1-01 | 월드 | M1-01 | Codex | — | 구현 |\n| T1-02 | 로비 | M1-02 | Codex | — | 구현 |'));
    const { ready } = nextActions(rows, { hasPlan: (id: string) => id === 'T1-02' });
    expect(ready.Claude?.[0]).toMatchObject({ what: '계획(문서 없음)', row: { id: 'T1-01' } });
    expect(ready.Codex?.map((i) => i.row.id)).toEqual(['T1-02']);
  });

  it('다음 관문의 계획 대기 작업을 미리 보여 준다', () => {
    const rows = parseQueue(
      table('| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |\n| T2-02 | 지인 테스트 | M2-02 | 사용자 | M1 | 구현 |'),
    );
    const result = nextActions(rows);
    expect(result.ahead.map((r) => r.id)).toEqual(['T2-01']);
    const text = render(result);
    expect(text).toContain('[계획] 구현 전 계획이 필요한 작업 1건');
    expect(text).toContain('M2 1건: T2-01 다중 월드(구현 Codex)');
  });

  it('형식이 틀리면 알려 준다', () => {
    expect(() => parseQueue(table('| T1-01 | 뼈대 | M1-01 | Gemini | — | 구현 |'))).toThrow('구현 담당');
    expect(() => parseQueue(table('| T1-01 | 뼈대 | M1-01 | Codex | — | 진행 |'))).toThrow('단계');
    expect(() => nextActions(parseQueue(table('| T1-01 | 뼈대 | M1-01 | Codex | T9-99 | 구현 |')))).toThrow('없는 선행');
  });

  it('실제 대기열을 읽을 수 있다', () => {
    const markdown = readFileSync(new URL('../docs/product/phases.md', import.meta.url), 'utf8');
    const rows = parseQueue(markdown);
    expect(rows.length).toBeGreaterThan(40);
    expect(render(nextActions(rows))).toContain('현재 관문 M1');
  });
});
