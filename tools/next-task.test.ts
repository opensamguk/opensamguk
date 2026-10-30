import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextActions, parseQueue, render } from './next-task.mjs';

const table = (rows: string) => `| ID | 작업 | AC | 구현 | 선행 | 단계 |\n| -- | -- | -- | -- | -- | -- |\n${rows}`;

describe('다음 작업 출력', () => {
  it('진행중 작업은 다른 구현 대기보다 먼저 표시한다', () => {
    const rows = parseQueue(
      table('| T1-01 | 대기 | M1-01 | Codex | — | 구현 |\n| T1-02 | 착수 | M1-02 | Codex | — | 진행중 |'),
    );
    const result = nextActions(rows);
    expect(result.ready.Codex?.[0]).toMatchObject({ what: '진행중', row: { id: 'T1-02' } });
    expect(render(result)).toContain('[Codex] 진행중 T1-02');
  });

  it.each(['Codex', 'Claude', '사용자'])('%s 담당의 동시 진행중 여러 건을 허용한다', (owner) => {
    const rows = parseQueue(
      table(`| T1-01 | 하나 | M1-01 | ${owner} | — | 진행중 |\n| T1-02 | 둘 | M1-02 | ${owner} | — | 진행중 |`),
    );
    expect(nextActions(rows).ready[owner]?.map((item) => item.row.id)).toEqual(['T1-01', 'T1-02']);
  });

  it('진행중이 많아도 모두 표시하고 구현 대기만 요약한다', () => {
    const active = Array.from({ length: 8 }, (_, i) => `T1-${String(i + 2).padStart(2, '0')}`);
    const rows = parseQueue(
      table(
        [
          '| T1-01 | 대기 | M1-01 | Codex | — | 구현 |',
          ...active.map((id) => `| ${id} | 병렬 작업 | M1-01 | Codex | — | 진행중 |`),
        ].join('\n'),
      ),
    );
    const output = render(nextActions(rows));
    expect(output.match(/^\[Codex\] 진행중 /gm)).toHaveLength(8);
    for (const id of active) expect(output).toContain(`[Codex] 진행중 ${id} 병렬 작업`);
    expect(output).toContain('그 밖에 1건: T1-01 구현');
  });

  it('병렬 작업이어도 선행이 완료되지 않은 진행중 작업은 선행 대기로 표시한다', () => {
    const rows = parseQueue(
      table('| T1-01 | 선행 | M1-01 | Codex | — | 진행중 |\n| T1-02 | 후속 | M1-02 | Codex | T1-01 | 진행중 |'),
    );
    const result = nextActions(rows);
    expect(result.ready.Codex?.map((item) => item.row.id)).toEqual(['T1-01']);
    expect(result.blocked.map((item) => item.row.id)).toEqual(['T1-02']);
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
    const rows = parseQueue(
      table('| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |\n| T1-02 | 월드 | M1-02 | Codex | T1-01 | 계획 |'),
    );
    const { ready } = nextActions(rows);
    expect(ready.Claude?.[0]).toMatchObject({ what: '계획', row: { id: 'T1-02' } });
    expect(ready.Codex?.[0]).toMatchObject({ what: '구현', row: { id: 'T1-01' } });
  });

  it('선행이 끝나지 않은 구현은 대기로 둔다', () => {
    const rows = parseQueue(
      table('| T1-01 | 뼈대 | M1-01 | Codex | — | 리뷰 |\n| T1-02 | 화면 | M1-02 | Claude | T1-01 | 구현 |'),
    );
    const { ready, blocked } = nextActions(rows);
    expect(ready.Claude?.map((i) => i.row.id)).toEqual(['T1-01']);
    expect(blocked.map((b) => b.row.id)).toEqual(['T1-02']);
  });

  it('현재 관문이 끝나야 다음 관문 작업이 나온다', () => {
    const rows = parseQueue(
      table(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 구현 |\n| T2-02 | 로비 | M2-02 | Claude | T2-01~T2-01 | 구현 |',
      ),
    );
    const result = nextActions(rows);
    expect(result.milestone).toBe(2);
    expect(result.ready.Codex?.[0]?.row.id).toBe('T2-01');
    expect(result.blocked.map((b) => b.row.id)).toEqual(['T2-02']);
  });

  it('구현 단계여도 계획 문서가 없으면 Claude가 먼저 계획한다', () => {
    const rows = parseQueue(
      table('| T1-01 | 월드 | M1-01 | Codex | — | 구현 |\n| T1-02 | 로비 | M1-02 | Codex | — | 구현 |'),
    );
    const { ready } = nextActions(rows, { hasPlan: (id: string) => id === 'T1-02' });
    expect(ready.Claude?.[0]).toMatchObject({ what: '계획(문서 없음)', row: { id: 'T1-01' } });
    expect(ready.Codex?.map((i) => i.row.id)).toEqual(['T1-02']);
  });

  it('다음 관문의 계획 대기 작업을 미리 보여 준다', () => {
    const rows = parseQueue(
      table(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |\n| T2-02 | 지인 테스트 | M2-02 | 사용자 | M1 | 구현 |',
      ),
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
    expect(() => nextActions(parseQueue(table('| T1-01 | 뼈대 | M1-01 | Codex | T9-99 | 구현 |')))).toThrow(
      '없는 선행',
    );
  });

  it('실제 대기열을 읽을 수 있다', () => {
    const markdown = readFileSync(new URL('../docs/product/phases.md', import.meta.url), 'utf8');
    const rows = parseQueue(markdown);
    expect(rows.length).toBeGreaterThan(40);
    expect(render(nextActions(rows))).toContain('현재 관문 M1');
  });
});

const PHASE2_HEAD = '[Phase 2] T4 작업은 관문 계산에 넣지 않습니다. 명령 작업의 완료는 AC-M1-14로 판정합니다.';
const lines = (...items: string[]) => items.join('\n');
const ids = (items: { row: { id: string } }[] | undefined) => items?.map((item) => item.row.id);
const waits = (items: { row: { id: string }; waitingOn: { id: string }[] }[] | undefined) =>
  items?.map((item) => [item.row.id, item.waitingOn.map((dep) => dep.id)]);

// 76d56d0(= 0115e6b, blob a6a0bfd)의 next-task.mjs로 구현 전에 만든 출력이다. 새 코드로 다시 만들지 않는다.
const GOLDEN_TABLE = lines(
  '| T1-01 | 뼈대 | M1-01 | Codex | — | 진행중 |',
  '| T1-02 | 화면 | M1-02 | Claude | T1-01 | 구현 |',
  '| T1-03 | 저장 | M1-03 | Codex | — | 구현 |',
  '| T1-04 | 로그 | M1-04 | Claude | — | 리뷰 |',
  '| T1-05 | 지도 | M1-05 | Codex | T1-01~T1-02 | 계획 |',
  '| T1-06 | 장수 화면 | M1-06 | Claude | — | 구현 |',
  '| T1-07 | 데모 | M1-07 | 사용자 | T1-03 | 구현 |',
  '| T1-08 | 점검 | M1-08 | 사용자 | — | 구현 |',
  '| T1-09 | 내정 | M1-09 | Codex | — | 구현 |',
  '| T1-10 | 징병 | M1-10 | Codex | — | 구현 |',
  '| T1-11 | 출병 | M1-11 | Codex | — | 구현 |',
  '| T1-12 | 외교 | M1-12 | Codex | — | 구현 |',
  '| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |',
  '| T2-02 | 로비: 입장 | M2-02 | Claude | T2-01 | 구현 |',
  '| T2-03 | 초대 | M2-03 | Codex | M1 | 계획 |',
  '| T2-04 | 공지 | M2-04 | Claude | M1 | 계획 |',
  '| T2-05 | 채팅 | M2-05 | Codex | M1 | 계획 |',
  '| T3-01 | 결제 | M3-01 | Codex | M2 | 계획 |',
);
const GOLDEN_OUTPUT = lines(
  '다음 작업 · 현재 관문 M1 · 기준: docs/product/phases.md',
  '흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽)',
  '',
  '[Codex] 진행중 T1-01 뼈대 (AC-M1-01) · 리뷰는 Claude',
  '    그 밖에 6건: T1-03 구현, T1-04 리뷰, T1-09 구현, T1-10 구현, T1-11 구현 …',
  '[Claude] 계획 T1-05 지도 (AC-M1-05) · 구현은 Codex',
  '    그 밖에 1건: T1-06 구현',
  '[사용자] 진행 T1-08 점검 (AC-M1-08)',
  '',
  '[계획] 구현 전 계획이 필요한 작업 7건 (Claude)',
  '    M1 (현재) 1건: T1-05 지도(구현 Codex)',
  '    M2 5건: T2-01 다중 월드(구현 Codex), T2-02 로비(구현 Claude), T2-03 초대(구현 Codex), T2-04 공지(구현 Claude) …',
  '    M3 1건: T3-01 결제(구현 Codex)',
  '',
  '선행 대기 2건: T1-02(Claude 구현 ← T1-01), T1-07(사용자 진행 ← T1-03)',
);

// 아래 표와 기대 출력은 docs/plans/T4-01.md의 예상 출력을 그대로 옮겼다.
const GATE_ROWS = lines(
  '| T1-01 | 뼈대 | M1-01 | Codex | — | 진행중 |',
  '| T1-02 | 화면 | M1-02 | Claude | T1-01 | 구현 |',
  '| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |',
);
const PHASE2_ROWS = lines(
  '| T4-01 | next 분리 | P2-01 | Claude | — | 리뷰 |',
  '| T4-02 | 명령 틀 | M1-14 | Codex | T1-01 | 구현 |',
  '| T4-03 | 저장 | M1-14 | Codex | T4-02, T2-01 | 구현 |',
  '| T4-33 | 전투 추출 | P2-16 | Codex | — | 계획 |',
);
const BOTH_OUTPUT = lines(
  '다음 작업 · 현재 관문 M1 · 기준: docs/product/phases.md',
  '흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽)',
  '',
  '[Codex] 진행중 T1-01 뼈대 (AC-M1-01) · 리뷰는 Claude',
  '[Claude] 할 일 없음',
  '[사용자] 할 일 없음',
  '',
  '[계획] 구현 전 계획이 필요한 작업 1건 (Claude)',
  '    M2 1건: T2-01 다중 월드(구현 Codex)',
  '',
  '선행 대기 1건: T1-02(Claude 구현 ← T1-01)',
  '',
  PHASE2_HEAD,
  '[Phase 2 Codex] 리뷰 T4-01 next 분리 (AC-P2-01)',
  '[Phase 2 Claude] 할 일 없음',
  '[Phase 2 사용자] 할 일 없음',
  '[Phase 2 계획] 구현 전 계획이 필요한 작업 1건 (Claude)',
  '    T4-33 전투 추출(구현 Codex)',
  'Phase 2 선행 대기 2건: T4-02(Codex 구현 ← T1-01), T4-03(Codex 구현 ← T4-02·T2-01)',
);
const ONLY_T4_OUTPUT = lines(
  'M1~M3 대기열에 남은 작업이 없습니다. 관문 통과는 인수조건으로 판정합니다.',
  '',
  PHASE2_HEAD,
  '[Phase 2 Codex] 할 일 없음',
  '[Phase 2 Claude] 진행중 T4-01 next 분리 (AC-P2-01) · 리뷰는 Codex',
  '[Phase 2 사용자] 할 일 없음',
);

// 최상위 네 키만 남긴다. T4 행을 뺀 표의 결과와 비교할 때 쓴다.
const gateOf = (result: ReturnType<typeof nextActions>) => {
  const { milestone, ready, blocked, ahead } = result;
  return { milestone, ready, blocked, ahead };
};
const run = (rows: string, options?: Parameters<typeof nextActions>[1]) =>
  nextActions(parseQueue(table(rows)), options);

describe('다음 작업 출력의 Phase 2 절', () => {
  it('T4 행이 없으면 반환 모양이 지금과 같다', () => {
    const tables = [
      '| T1-01 | 대기 | M1-01 | Codex | — | 구현 |\n| T1-02 | 착수 | M1-02 | Codex | — | 진행중 |',
      '| T1-01 | 백엔드 | M1-01 | Codex | — | 리뷰 |\n| T1-02 | 화면 | M1-02 | Claude | — | 리뷰 |',
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 리뷰 |\n| T1-02 | 화면 | M1-02 | Claude | T1-01 | 구현 |',
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 구현 |\n| T2-02 | 로비 | M2-02 | Claude | T2-01~T2-01 | 구현 |',
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |\n| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |\n| T2-02 | 지인 테스트 | M2-02 | 사용자 | M1 | 구현 |',
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |',
      GOLDEN_TABLE,
    ];
    for (const rows of tables) {
      const result = run(rows);
      expect(Object.keys(result)).toEqual(['milestone', 'ready', 'blocked', 'ahead']);
      expect(result).not.toHaveProperty('phase2');
    }
  });

  it('T4 행이 없으면 출력이 고정 골든과 바이트로 같다', () => {
    expect(render(run(GOLDEN_TABLE, { hasPlan: (id: string) => id !== 'T2-02' }))).toBe(GOLDEN_OUTPUT);
  });

  // phases.md에 T4 행이 있든 없든 통과해야 한다. 기대값은 파싱한 행과 계획의 문구에서 계산한다.
  it('실제 대기열은 T4 유무에 맞게 Phase 2 절을 낸다', () => {
    const markdown = readFileSync(new URL('../docs/product/phases.md', import.meta.url), 'utf8');
    const rows = parseQueue(markdown);
    const isT4 = (row: { milestone: number }) => row.milestone === 4;
    const t4Rows = rows.filter(isT4);
    const gateRows = rows.filter((row) => row.milestone < 4);
    const openT4 = t4Rows.filter((row) => row.stage !== '완료').map((row) => row.id);
    const gateIds = (result: ReturnType<typeof nextActions>) => [
      ...Object.values(result.ready).flatMap((items) => ids(items) ?? []),
      ...(ids(result.blocked) ?? []),
      ...result.ahead.map((row) => row.id),
    ];

    // 실제 표 그대로. 관문은 T4를 뺀 행으로 정하고 T4는 phase2에만 들어간다.
    const result = nextActions(rows);
    const output = render(result);
    expect(result.milestone).toBe(gateRows.find((row) => row.stage !== '완료')?.milestone ?? null);
    expect(gateIds(result).filter((id) => id.startsWith('T4-'))).toEqual([]);
    expect(output).not.toContain('M4');
    if (t4Rows.length === 0) {
      expect(Object.keys(result)).toEqual(['milestone', 'ready', 'blocked', 'ahead']);
      expect(output).not.toContain('Phase 2');
    } else {
      expect(Object.keys(result)).toEqual([
        'milestone',
        'ready',
        'blocked',
        'ahead',
        'phase2',
        ...(rows.some((r) => r.id.startsWith('INT-')) ? ['integration'] : []),
      ]);
      const { phase2 } = result;
      const phase2Ids = [
        ...Object.values(phase2?.ready ?? {}).flatMap((items) => ids(items) ?? []),
        ...(ids(phase2?.blocked) ?? []),
        ...(phase2?.ahead.map((row) => row.id) ?? []),
      ];
      expect(phase2Ids.sort()).toEqual([...openT4].sort());
      expect(nextActions([...t4Rows, ...gateRows, ...rows.filter((r) => r.milestone === 5)])).toEqual(result);
      expect(output.includes(`\n${PHASE2_HEAD}\n`)).toBe(openT4.length > 0);
    }

    // T4를 뺀 표. T4를 가리키는 선행도 지운다. 지금 출력 모양 그대로여야 한다.
    const stripT4 = (deps: string) => {
      const kept = deps
        .split(',')
        .map((dep) => dep.trim())
        .filter((dep) => dep !== '' && dep !== '—' && !/T4-\d{2}/.test(dep));
      return kept.length > 0 ? kept.join(', ') : '—';
    };
    const withoutT4 = gateRows.map((row) => ({ ...row, deps: stripT4(row.deps) }));
    const gateOnly = nextActions(withoutT4);
    expect(Object.keys(gateOnly)).toEqual(['milestone', 'ready', 'blocked', 'ahead']);
    expect(render(gateOnly)).not.toContain('Phase 2');

    // T4를 뺀 표에 T4 세 줄을 더한다. 관문 쪽은 그대로이고 끝에 Phase 2 절만 붙는다.
    const first = withoutT4[0];
    const sample = parseQueue(
      table(
        lines(
          '| T4-97 | 실제 표 진행 | P2-01 | Codex | — | 진행중 |',
          `| T4-98 | 실제 표 대기 | P2-01 | Claude | T4-97, ${first.id} | 구현 |`,
          '| T4-99 | 실제 표 계획 | P2-01 | Codex | — | 계획 |',
        ),
      ),
    );
    const waiting = ['T4-97', ...(first.stage === '완료' ? [] : [first.id])].join('·');
    const withSample = nextActions([...withoutT4, ...sample]);
    expect(gateOf(withSample)).toEqual(gateOnly);
    const head =
      gateOnly.milestone === null
        ? 'M1~M3 대기열에 남은 작업이 없습니다. 관문 통과는 인수조건으로 판정합니다.'
        : render(gateOnly);
    expect(render(withSample)).toBe(
      lines(
        head,
        '',
        PHASE2_HEAD,
        '[Phase 2 Codex] 진행중 T4-97 실제 표 진행 (AC-P2-01) · 리뷰는 Claude',
        '[Phase 2 Claude] 할 일 없음',
        '[Phase 2 사용자] 할 일 없음',
        '[Phase 2 계획] 구현 전 계획이 필요한 작업 1건 (Claude)',
        '    T4-99 실제 표 계획(구현 Codex)',
        `Phase 2 선행 대기 1건: T4-98(Claude 구현 ← ${waiting})`,
      ),
    );
  });

  it('T4만 있으면 전체 완료라고 하지 않는다', () => {
    const only = '| T4-01 | next 분리 | P2-01 | Claude | — | 진행중 |';
    for (const rows of [only, `| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n${only}`]) {
      const output = render(run(rows));
      expect(output).toBe(ONLY_T4_OUTPUT);
      expect(output).not.toContain('모든 작업이 완료됐습니다');
    }
  });

  it('T4는 Phase 2 절로 따로 보이고 M4가 없다', () => {
    const result = run(`${GATE_ROWS}\n${PHASE2_ROWS}`);
    const output = render(result);
    expect(output).toBe(BOTH_OUTPUT);
    expect(output).not.toContain('M4');
    const gateOnly = run(GATE_ROWS);
    expect(gateOf(result)).toEqual(gateOnly);
    expect(output.split('\n').slice(0, 11).join('\n')).toBe(render(gateOnly));
  });

  it('T4가 표 앞에 있어도 현재 관문이 같다', () => {
    const result = run(`${PHASE2_ROWS}\n${GATE_ROWS}`);
    expect(result.milestone).toBe(1);
    expect(render(result)).toBe(BOTH_OUTPUT);
  });

  it('M1~M3이 끝나도 남은 T4가 있으면 Phase 2 절만 낸다', () => {
    const result = run(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n| T4-01 | next 분리 | P2-01 | Claude | — | 계획 |',
    );
    expect(result.milestone).toBeNull();
    expect(render(result)).toBe(
      lines(
        'M1~M3 대기열에 남은 작업이 없습니다. 관문 통과는 인수조건으로 판정합니다.',
        '',
        PHASE2_HEAD,
        '[Phase 2 Codex] 할 일 없음',
        '[Phase 2 Claude] 할 일 없음',
        '[Phase 2 사용자] 할 일 없음',
        '[Phase 2 계획] 구현 전 계획이 필요한 작업 1건 (Claude)',
        '    T4-01 next 분리(구현 Claude)',
      ),
    );
  });

  it('T1~T3과 T4가 모두 완료면 지금 문구다', () => {
    const result = run(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |\n| T4-01 | next 분리 | P2-01 | Claude | — | 완료 |',
    );
    expect(result).toEqual({
      milestone: null,
      ready: {},
      blocked: [],
      ahead: [],
      phase2: { ready: {}, blocked: [], ahead: [] },
    });
    expect(render(result)).toBe('모든 작업이 완료됐습니다.');
  });

  it('T4 선행에 T1~T3 ID를 쓸 수 있다', () => {
    const result = run(
      lines(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 진행중 |',
        '| T2-01 | 다중 월드 | M2-01 | Codex | — | 완료 |',
        '| T4-02 | 명령 틀 | M1-14 | Codex | T1-01 | 구현 |',
        '| T4-03 | 저장 | M1-14 | Codex | T2-01 | 구현 |',
      ),
    );
    expect(waits(result.phase2?.blocked)).toEqual([['T4-02', ['T1-01']]]);
    expect(ids(result.phase2?.ready.Codex)).toEqual(['T4-03']);
  });

  it('관문 작업도 T4 ID를 선행으로 적을 수 있다', () => {
    const result = run(
      '| T1-02 | 화면 | M1-02 | Claude | T4-01 | 구현 |\n| T4-01 | next 분리 | P2-01 | Codex | — | 구현 |',
    );
    expect(waits(result.blocked)).toEqual([['T1-02', ['T4-01']]]);
    expect(render(result)).toContain('\n\n선행 대기 1건: T1-02(Claude 구현 ← T4-01)\n\n[Phase 2]');
  });

  it('T4 선행에 같은 대기열의 범위를 쓸 수 있다', () => {
    const result = run(
      lines(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |',
        '| T1-02 | 화면 | M1-02 | Claude | — | 구현 |',
        '| T4-02 | 명령 틀 | M1-14 | Codex | — | 완료 |',
        '| T4-03 | 저장 | M1-14 | Codex | — | 구현 |',
        '| T4-05 | 표 | M1-14 | Claude | T1-01~T1-02 | 구현 |',
        '| T4-06 | 결과 | M1-14 | Codex | T4-02~T4-03 | 구현 |',
      ),
    );
    expect(waits(result.phase2?.blocked)).toEqual([
      ['T4-05', ['T1-02']],
      ['T4-06', ['T4-03']],
    ]);
  });

  it('두 대기열에 걸친 범위는 거부한다', () => {
    const phase2 = lines(
      '| T3-01 | 결제 | M3-01 | Codex | — | 구현 |',
      '| T4-01 | next 분리 | P2-01 | Claude | — | 구현 |',
      '| T4-05 | 표 | M1-14 | Claude | T3-01~T4-01 | 구현 |',
    );
    expect(() => run(phase2)).toThrow(
      new Error('T4-05: 범위 T3-01~T4-01의 두 끝이 서로 다른 대기열(M1~M3, Phase 2)에 있습니다'),
    );
    const gate = lines(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
      '| T1-02 | 화면 | M1-02 | Claude | T4-01~T1-01 | 구현 |',
      '| T4-01 | next 분리 | P2-01 | Claude | — | 완료 |',
    );
    expect(() => run(gate)).toThrow(
      new Error('T1-02: 범위 T4-01~T1-01의 두 끝이 서로 다른 대기열(M1~M3, Phase 2)에 있습니다'),
    );
  });

  it('T1~T3 범위는 두 끝 사이의 T4 행을 선행에 넣지 않는다', () => {
    const t13 = '| T1-03 | 저장 | M1-03 | Codex | T1-01~T1-02 | 구현 |';
    const t11 = '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |';
    const t41 = '| T4-01 | next 분리 | P2-01 | Codex | — | 구현 |';
    const t12 = '| T1-02 | 화면 | M1-02 | Claude | — | 완료 |';
    const result = run(lines(t13, t11, t41, t12));
    expect(ids(result.ready.Codex)).toEqual(['T1-03']);
    expect(result.blocked).toEqual([]);
    expect(gateOf(result)).toEqual(run(lines(t13, t11, t12)));
  });

  it('Phase 2 범위는 두 끝 사이의 T1~T3 행을 선행에 넣지 않는다', () => {
    const result = run(
      lines(
        '| T4-03 | 저장 | M1-14 | Codex | T4-01~T4-02 | 구현 |',
        '| T4-01 | next 분리 | P2-01 | Claude | — | 완료 |',
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
        '| T4-02 | 명령 틀 | M1-14 | Codex | — | 완료 |',
      ),
    );
    expect(ids(result.phase2?.ready.Codex)).toEqual(['T4-03']);
    expect(result.phase2?.blocked).toEqual([]);
    expect(ids(result.ready.Codex)).toEqual(['T1-01']);
  });

  it('T4가 없으면 범위 안쪽 행은 관문 번호와 상관없이 지금처럼 든다', () => {
    const result = run(
      lines(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |',
        '| T2-01 | 다중 월드 | M2-01 | Codex | — | 구현 |',
        '| T1-02 | 화면 | M1-02 | Codex | — | 구현 |',
        '| T2-05 | 로비 | M2-05 | Claude | T1-01~T1-02 | 구현 |',
      ),
    );
    // 기대값은 76d56d0 도구로 같은 표를 돌린 반환과 출력이다.
    expect(Object.keys(result)).toEqual(['milestone', 'ready', 'blocked', 'ahead']);
    expect(result.milestone).toBe(2);
    expect(result.ready.Codex?.map((item) => [item.row.id, item.what])).toEqual([['T2-01', '구현']]);
    expect(result.blocked.map((b) => [b.row.id, b.who, b.what, b.waitingOn.map((d) => d.id)])).toEqual([
      ['T2-05', 'Claude', '구현', ['T2-01', 'T1-02']],
    ]);
    expect(result.ahead).toEqual([]);
    expect(render(result)).toBe(
      lines(
        '다음 작업 · 현재 관문 M2 · 기준: docs/product/phases.md',
        '흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽)',
        '',
        '[Codex] 구현 T2-01 다중 월드 (AC-M2-01) · 리뷰는 Claude',
        '[Claude] 할 일 없음',
        '[사용자] 할 일 없음',
        '',
        '[계획] 구현 전 계획이 필요한 작업 0건 (Claude)',
        '    없음',
        '',
        '선행 대기 1건: T2-05(Claude 구현 ← T2-01·T1-02)',
      ),
    );
  });

  it('뒤집힌 범위는 지금처럼 빈 목록이다', () => {
    const result = run(
      lines(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
        '| T1-02 | 화면 | M1-02 | Claude | T1-02~T1-01 | 구현 |',
        '| T4-01 | next 분리 | P2-01 | Codex | — | 구현 |',
        '| T4-02 | 명령 틀 | M1-14 | Codex | — | 구현 |',
        '| T4-03 | 저장 | M1-14 | Codex | T4-02~T4-01 | 구현 |',
      ),
    );
    expect(result.blocked).toEqual([]);
    expect(result.phase2?.blocked).toEqual([]);
    expect(ids(result.ready.Claude)).toEqual(['T1-02']);
    expect(ids(result.phase2?.ready.Codex)).toEqual(['T4-01', 'T4-02', 'T4-03']);
  });

  it('없는 끝은 대기열 검사보다 먼저 지금 메시지로 거부한다', () => {
    const rows = lines(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
      '| T4-05 | 표 | M1-14 | Claude | T1-01~T4-99 | 구현 |',
    );
    expect(() => run(rows)).toThrow(new Error('T4-05: 없는 선행 범위 T1-01~T4-99'));
  });

  it('선행의 M4는 어느 행이든 거부한다', () => {
    const gate = lines(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
      '| T1-02 | 화면 | M1-02 | Claude | M4 | 구현 |',
      '| T4-01 | next 분리 | P2-01 | Claude | — | 구현 |',
    );
    expect(() => run(gate)).toThrow(new Error('T1-02: M4 관문은 없습니다. Phase 2 작업은 T4 ID나 범위로 적습니다'));
    const phase2 = lines(
      '| T4-01 | next 분리 | P2-01 | Claude | — | 구현 |',
      '| T4-02 | 명령 틀 | M1-14 | Codex | M4 | 구현 |',
    );
    expect(() => run(phase2)).toThrow(new Error('T4-02: M4 관문은 없습니다. Phase 2 작업은 T4 ID나 범위로 적습니다'));
  });

  it('T4 선행에 관문 전체를 쓰지 않는다', () => {
    const rows = lines(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 완료 |',
      '| T4-02 | 명령 틀 | M1-14 | Codex | M1 | 구현 |',
    );
    expect(() => run(rows)).toThrow(new Error('T4-02: Phase 2 작업의 선행은 관문(M1) 대신 작업 ID나 범위로 적습니다'));
  });

  it('T4 선행의 없는 ID는 지금 메시지로 거부한다', () => {
    const withDeps = (deps: string) =>
      lines(
        '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
        '| T2-01 | 다중 월드 | M2-01 | Codex | — | 구현 |',
        '| T4-01 | next 분리 | P2-01 | Claude | — | 구현 |',
        `| T4-02 | 명령 틀 | M1-14 | Codex | ${deps} | 구현 |`,
      );
    expect(() => run(withDeps('T4-99'))).toThrow(new Error('T4-02: 없는 선행 작업 T4-99'));
    expect(() => run(withDeps('병합 T4-30'))).toThrow(new Error('T4-02: 없는 선행 작업 병합 T4-30'));
    expect(() => run(withDeps('T4-01~T4-99'))).toThrow(new Error('T4-02: 없는 선행 범위 T4-01~T4-99'));
  });

  it('선행이 끝나지 않은 T4는 Phase 2 선행 대기다', () => {
    const rows = lines(
      '| T1-18 | 완주 데모 | M1-21 | 사용자 | — | 구현 |',
      '| T4-02 | 명령 틀 | M1-14 | Codex | T1-18 | 구현 |',
    );
    const output = render(run(rows));
    expect(output.split('\n').at(-1)).toBe('Phase 2 선행 대기 1건: T4-02(Codex 구현 ← T1-18)');
  });

  it('계획 문서가 없는 T4는 Phase 2 계획으로 간다', () => {
    const gate = lines(
      '| T1-01 | 뼈대 | M1-01 | Codex | — | 구현 |',
      '| T2-01 | 다중 월드 | M2-01 | Codex | M1 | 계획 |',
    );
    const hasPlan = (id: string) => id !== 'T4-02';
    const result = run(`${gate}\n| T4-02 | 명령 틀 | M1-14 | Codex | — | 구현 |`, { hasPlan });
    expect(result.phase2?.ahead.map((row) => row.id)).toEqual(['T4-02']);
    expect(result.phase2?.ready).toEqual({});
    expect(gateOf(result)).toEqual(run(gate, { hasPlan }));
    const output = render(result);
    expect(output).toContain('\n[계획] 구현 전 계획이 필요한 작업 1건 (Claude)\n');
    expect(output).toContain('\n[Phase 2 계획] 구현 전 계획이 필요한 작업 1건 (Claude)\n    T4-02 명령 틀(구현 Codex)');
  });

  it('T4의 진행중과 리뷰 상태를 그대로 보인다', () => {
    const rows = lines('| T4-02 | 틀 | M1-14 | Codex | — | 진행중 |', '| T4-04 | 화면 | M1-14 | Claude | — | 리뷰 |');
    expect(render(run(rows))).toContain(
      '\n[Phase 2 Codex] 진행중 T4-02 틀 (AC-M1-14) · 리뷰는 Claude\n    그 밖에 1건: T4-04 리뷰\n[Phase 2 Claude] 할 일 없음',
    );
  });

  it('순환 선행은 지금처럼 서로 선행 대기로 둔다', () => {
    const rows = lines(
      '| T4-10 | 앞 | M1-14 | Codex | T4-11 | 구현 |',
      '| T4-11 | 뒤 | M1-14 | Claude | T4-10 | 구현 |',
    );
    const result = run(rows);
    expect(waits(result.phase2?.blocked)).toEqual([
      ['T4-10', ['T4-11']],
      ['T4-11', ['T4-10']],
    ]);
    expect(result.phase2?.ready).toEqual({});
  });

  it('T4 행도 담당·단계 형식을 검사한다', () => {
    expect(() => parseQueue(table('| T4-01 | next 분리 | P2-01 | Gemini | — | 구현 |'))).toThrow(
      new Error('T4-01: 구현 담당은 Codex·Claude·사용자 중 하나여야 합니다 ("Gemini")'),
    );
    expect(() => parseQueue(table('| T4-01 | 데모 | P2-01 | 사용자 | — | 리뷰 |'))).toThrow(
      new Error('T4-01: 사용자 작업은 구현·완료 단계만 씁니다'),
    );
  });
});

describe('통합 대기열', () => {
  it('INT 문자 접미사의 선행과 범위를 보존하며 기존 관문을 섞지 않는다', () => {
    const rows = parseQueue(
      table(
        [
          '| INT-18A | 정본 | INT-18A | Codex | — | 완료 |',
          '| T1-01 | 관문 | M1-01 | Codex | — | 구현 |',
          '| INT-18B | 저장 | INT-18B | Codex | INT-18A | 완료 |',
          '| INT-18C | 화면 | INT-18C | Codex | INT-18A~INT-18B | 진행중 |',
          '| INT-18D | 인수 | INT-18D | Codex | INT-18C | 구현 |',
        ].join('\n'),
      ),
    );
    const result = nextActions(rows);
    expect(result.milestone).toBe(1);
    expect(result.integration?.ready.Codex?.map((item) => item.row.id)).toEqual(['INT-18C']);
    expect(result.integration?.blocked.map((item) => [item.row.id, item.waitingOn.map((row) => row.id)])).toEqual([
      ['INT-18D', ['INT-18C']],
    ]);
    expect(render(result)).toContain('[통합 Codex] 진행중 INT-18C');
    rows.at(-1)!.deps = 'INT-18E';
    expect(() => nextActions(rows)).toThrow('없는 선행 작업 INT-18E');
  });
  it('문자 접미사는 INT 한 글자만 읽으며 T 작업 문법은 유지한다', () => {
    const rows = parseQueue(
      table(
        [
          '| INT-18A | 정본 | INT-18A | Codex | — | 진행중 |',
          '| INT-18AA | 오기 | INT-18AA | Codex | — | 진행중 |',
          '| T1-01A | 오기 | M1-01 | Codex | — | 진행중 |',
          '| T1-01 | 관문 | M1-01 | Codex | — | 구현 |',
        ].join('\n'),
      ),
    );
    expect(rows.map((row) => row.id)).toEqual(['INT-18A', 'T1-01']);
  });
  it('INT rows do not become a gate or hide existing Phase 2 work', () => {
    const rows = parseQueue(
      table(
        [
          '| INT-01 | 통합 | INT-01 | Codex | — | 진행중 |',
          '| T1-01 | 관문 | M1-01 | Codex | — | 구현 |',
          '| T4-01 | 확장 | P2-01 | Claude | — | 구현 |',
          '| INT-02 | 저장 | INT-02 | Codex | INT-01 | 구현 |',
        ].join('\n'),
      ),
    );
    const result = nextActions(rows);
    expect(result.milestone).toBe(1);
    expect(result.integration?.blocked[0]?.waitingOn[0]?.id).toBe('INT-01');
    const output = render(result);
    expect(output).toContain('[통합 Codex] 진행중 INT-01');
    expect(output).toContain('[Phase 2 Claude] 구현 T4-01');
    expect(output).not.toContain('현재 관문 M5');
  });
  it('shows integration review even when every original gate is done', () => {
    const rows = parseQueue(table('| INT-13 | 편집기 | INT-13 | Codex | — | 리뷰 |'));
    expect(render(nextActions(rows))).toContain('[통합 Claude] 리뷰 INT-13');
  });
  it('keeps missing plans visible and validates unknown integration dependencies', () => {
    const rows = parseQueue(table('| INT-02 | 저장 | INT-02 | Codex | — | 진행중 |'));
    expect(nextActions(rows, { hasPlan: () => false }).integration?.ahead[0]?.id).toBe('INT-02');
    rows[0]!.deps = 'INT-99';
    expect(() => nextActions(rows)).toThrow('없는 선행 작업');
  });
  it('integration ranges exclude interleaved gate rows and reject mixed endpoints', () => {
    const rows = parseQueue(
      table(
        [
          '| INT-01 | 기준 | INT-01 | Codex | — | 완료 |',
          '| T1-01 | 관문 | M1-01 | Codex | — | 구현 |',
          '| INT-02 | 저장 | INT-02 | Codex | — | 완료 |',
          '| INT-03 | 경로 | INT-03 | Codex | INT-01~INT-02 | 구현 |',
        ].join('\n'),
      ),
    );
    expect(nextActions(rows).integration?.blocked).toHaveLength(0);
    rows[3]!.deps = 'INT-01~T1-01';
    expect(() => nextActions(rows)).toThrow('서로 다른 대기열');
  });
});
