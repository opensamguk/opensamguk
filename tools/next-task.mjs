#!/usr/bin/env node
// 다음 작업과 담당을 출력한다. 기준: docs/product/phases.md의 작업 대기열.
// 흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽) → 완료
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STAGES = ['계획', '구현', '진행중', '리뷰', '완료'];
const OWNERS = ['Codex', 'Claude', '사용자'];
const REVIEWER = { Codex: 'Claude', Claude: 'Codex' };
// T4 행은 Phase 2 대기열이다. 관문(M1~M3) 계산에 넣지 않고 따로 보인다.
const PHASE2 = 4;

export function parseQueue(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*(T(\d)-\d{2})\s*\|(.*)\|\s*$/);
    if (!match) continue;
    const cells = match[3].split('|').map((cell) => cell.trim());
    if (cells.length !== 5) throw new Error(`대기열 형식 오류 (칸 ${cells.length}개): ${line}`);
    const [title, ac, owner, deps, stage] = cells;
    if (!OWNERS.includes(owner))
      throw new Error(`${match[1]}: 구현 담당은 ${OWNERS.join('·')} 중 하나여야 합니다 ("${owner}")`);
    if (!STAGES.includes(stage))
      throw new Error(`${match[1]}: 단계는 ${STAGES.join('·')} 중 하나여야 합니다 ("${stage}")`);
    if (owner === '사용자' && (stage === '계획' || stage === '리뷰')) {
      throw new Error(`${match[1]}: 사용자 작업은 구현·완료 단계만 씁니다`);
    }
    rows.push({ id: match[1], milestone: Number(match[2]), title, ac, owner, deps, stage });
  }
  return rows;
}

function resolveDeps(row, rows) {
  if (row.deps === '—' || row.deps === '') return [];
  return row.deps.split(',').flatMap((part) => {
    const dep = part.trim();
    const milestone = dep.match(/^M(\d)$/);
    if (milestone) {
      if (Number(milestone[1]) === PHASE2)
        throw new Error(`${row.id}: M4 관문은 없습니다. Phase 2 작업은 T4 ID나 범위로 적습니다`);
      if (row.milestone === PHASE2)
        throw new Error(`${row.id}: Phase 2 작업의 선행은 관문(${dep}) 대신 작업 ID나 범위로 적습니다`);
      return rows.filter((r) => r.milestone === Number(milestone[1]));
    }
    const range = dep.match(/^(T\d-\d{2})~(T\d-\d{2})$/);
    if (range) {
      const from = rows.findIndex((r) => r.id === range[1]);
      const to = rows.findIndex((r) => r.id === range[2]);
      if (from < 0 || to < 0) throw new Error(`${row.id}: 없는 선행 범위 ${dep}`);
      const phase2 = rows[from].milestone === PHASE2;
      if (phase2 !== (rows[to].milestone === PHASE2))
        throw new Error(`${row.id}: 범위 ${dep}의 두 끝이 서로 다른 대기열(M1~M3, Phase 2)에 있습니다`);
      // 두 끝 사이에 낀 다른 대기열 행은 선행이 아니다. T4가 표 어디에 있든 결과가 같아야 한다.
      return rows.slice(from, to + 1).filter((r) => (r.milestone === PHASE2) === phase2);
    }
    const found = rows.find((r) => r.id === dep);
    if (!found) throw new Error(`${row.id}: 없는 선행 작업 ${dep}`);
    return [found];
  });
}

// 구현 전에 계획이 있어야 한다: 단계가 '계획'이거나, '구현'인데 계획 문서가 없으면 계획이 필요하다.
function needsPlan(row, hasPlan) {
  if (row.owner === '사용자') return false;
  return row.stage === '계획' || (['구현', '진행중'].includes(row.stage) && !hasPlan(row.id));
}

// targets의 행마다 선행을 풀고 담당별 할 일(ready)과 선행 대기(blocked)로 나눈다.
// planAhead를 주면 계획이 필요한 행을 Claude의 할 일 대신 그 배열에 모은다 (Phase 2).
function classify(targets, rows, hasPlan, planAhead) {
  const ready = {};
  const blocked = [];
  for (const row of targets) {
    const waitingOn = resolveDeps(row, rows).filter((d) => d.stage !== '완료');
    let who;
    let what;
    if (needsPlan(row, hasPlan)) {
      if (planAhead) {
        planAhead.push(row);
        continue;
      }
      who = 'Claude';
      what = row.stage === '계획' ? '계획' : '계획(문서 없음)';
    } else if (row.stage === '리뷰') {
      who = REVIEWER[row.owner];
      what = '리뷰';
    } else {
      who = row.owner;
      what = row.stage === '진행중' ? '진행중' : row.owner === '사용자' ? '진행' : '구현';
      if (waitingOn.length > 0) {
        blocked.push({ row, who, what, waitingOn });
        continue;
      }
    }
    (ready[who] ??= []).push({ row, what });
  }
  for (const items of Object.values(ready))
    items.sort((a, b) => Number(b.row.stage === '진행중') - Number(a.row.stage === '진행중'));
  return { ready, blocked };
}

// 현재 관문(완료되지 않은 첫 관문)에서 담당별로 지금 할 수 있는 일을 고르고,
// 다음 관문들의 계획 대기 작업을 따로 모은다 (계획은 선행과 상관없이 미리 쓸 수 있다).
// T4 행은 관문 계산에서 빼고, 하나라도 있으면 phase2에 따로 나눈다. 선행 이름은 표 전체에서 찾는다.
export function nextActions(rows, { hasPlan = () => true } = {}) {
  const gateRows = rows.filter((r) => r.milestone !== PHASE2);
  const current = gateRows.find((r) => r.stage !== '완료')?.milestone ?? null;
  const result =
    current === null
      ? { milestone: null, ready: {}, blocked: [], ahead: [] }
      : {
          milestone: current,
          ...classify(
            gateRows.filter((r) => r.milestone === current && r.stage !== '완료'),
            rows,
            hasPlan,
          ),
          ahead: gateRows.filter((r) => r.milestone > current && needsPlan(r, hasPlan)),
        };
  if (gateRows.length === rows.length) return result;

  // Phase 2 행은 관문과 상관없이 미완료이면 언제나 선행을 푼다. 없는 선행이 바로 드러난다.
  const ahead = [];
  const { ready, blocked } = classify(
    rows.filter((r) => r.milestone === PHASE2 && r.stage !== '완료'),
    rows,
    hasPlan,
    ahead,
  );
  return { ...result, phase2: { ready, blocked, ahead } };
}

function ownerLines(ready, prefix) {
  const lines = [];
  for (const who of ['Codex', 'Claude', '사용자']) {
    const items = ready[who] ?? [];
    const label = `[${prefix}${who}]`;
    if (items.length === 0) {
      lines.push(`${label} 할 일 없음`);
      continue;
    }
    const active = items.filter((item) => item.what === '진행중');
    const shownItems = active.length > 0 ? active : items.slice(0, 1);
    const rest = items.filter((item) => !shownItems.includes(item));
    for (const item of shownItems) {
      const handoff = item.what.startsWith('계획')
        ? ` · 구현은 ${item.row.owner}`
        : ['구현', '진행중'].includes(item.what) && item.row.owner !== '사용자'
          ? ` · 리뷰는 ${REVIEWER[item.row.owner]}`
          : '';
      lines.push(`${label} ${item.what} ${item.row.id} ${item.row.title} (AC-${item.row.ac})${handoff}`);
    }
    if (rest.length > 0) {
      const shown = rest
        .slice(0, 5)
        .map((i) => `${i.row.id} ${i.what}`)
        .join(', ');
      lines.push(`    그 밖에 ${rest.length}건: ${shown}${rest.length > 5 ? ' …' : ''}`);
    }
  }
  return lines;
}

function planList(list) {
  const shown = list
    .slice(0, 4)
    .map((r) => `${r.id} ${r.title.split(':')[0]}(구현 ${r.owner})`)
    .join(', ');
  return `${shown}${list.length > 4 ? ' …' : ''}`;
}

function waitList(blocked) {
  const shown = blocked
    .slice(0, 5)
    .map((b) => `${b.row.id}(${b.who} ${b.what} ← ${b.waitingOn.map((d) => d.id).join('·')})`);
  return `${blocked.length}건: ${shown.join(', ')}${blocked.length > 5 ? ' …' : ''}`;
}

function phase2Lines({ ready, blocked, ahead }) {
  const lines = [
    '[Phase 2] T4 작업은 관문 계산에 넣지 않습니다. 명령 작업의 완료는 AC-M1-14로 판정합니다.',
    ...ownerLines(ready, 'Phase 2 '),
  ];
  if (ahead.length > 0)
    lines.push(`[Phase 2 계획] 구현 전 계획이 필요한 작업 ${ahead.length}건 (Claude)`, `    ${planList(ahead)}`);
  if (blocked.length > 0) lines.push(`Phase 2 선행 대기 ${waitList(blocked)}`);
  return lines;
}

export function render({ milestone, ready, blocked, ahead = [], phase2 }) {
  const phase2Open =
    phase2 !== undefined &&
    (Object.keys(phase2.ready).length > 0 || phase2.blocked.length > 0 || phase2.ahead.length > 0);
  if (milestone === null && !phase2Open) return '모든 작업이 완료됐습니다.';
  const lines = [];
  if (milestone === null) {
    lines.push('M1~M3 대기열에 남은 작업이 없습니다. 관문 통과는 인수조건으로 판정합니다.');
  } else {
    lines.push(
      `다음 작업 · 현재 관문 M${milestone} · 기준: docs/product/phases.md`,
      '흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽)',
      '',
      ...ownerLines(ready, ''),
    );
    const planning = [...(ready.Claude ?? []).filter((i) => i.what.startsWith('계획')).map((i) => i.row), ...ahead];
    lines.push('', `[계획] 구현 전 계획이 필요한 작업 ${planning.length}건 (Claude)`);
    if (planning.length === 0) {
      lines.push('    없음');
    } else {
      const byMilestone = new Map();
      for (const row of planning) byMilestone.set(row.milestone, [...(byMilestone.get(row.milestone) ?? []), row]);
      for (const [m, list] of byMilestone)
        lines.push(`    M${m}${m === milestone ? ' (현재)' : ''} ${list.length}건: ${planList(list)}`);
    }
    if (blocked.length > 0) lines.push('', `선행 대기 ${waitList(blocked)}`);
  }
  if (phase2Open) lines.push('', ...phase2Lines(phase2));
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const markdown = readFileSync(new URL('../docs/product/phases.md', import.meta.url), 'utf8');
  const hasPlan = (id) => existsSync(new URL(`../docs/plans/${id}.md`, import.meta.url));
  console.log(render(nextActions(parseQueue(markdown), { hasPlan })));
}
