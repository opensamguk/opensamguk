#!/usr/bin/env node
// 다음 작업과 담당을 출력한다. 기준: docs/product/phases.md의 작업 대기열.
// 흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽) → 완료
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STAGES = ['계획', '구현', '진행중', '리뷰', '완료'];
const OWNERS = ['Codex', 'Claude', '사용자'];
const REVIEWER = { Codex: 'Claude', Claude: 'Codex' };

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
  for (const owner of OWNERS) {
    if (rows.filter((row) => row.owner === owner && row.stage === '진행중').length > 1) {
      throw new Error(`${owner}: 진행중 작업은 한 번에 하나만 둡니다`);
    }
  }
  return rows;
}

function resolveDeps(row, rows) {
  if (row.deps === '—' || row.deps === '') return [];
  return row.deps.split(',').flatMap((part) => {
    const dep = part.trim();
    const milestone = dep.match(/^M(\d)$/);
    if (milestone) return rows.filter((r) => r.milestone === Number(milestone[1]));
    const range = dep.match(/^(T\d-\d{2})~(T\d-\d{2})$/);
    if (range) {
      const from = rows.findIndex((r) => r.id === range[1]);
      const to = rows.findIndex((r) => r.id === range[2]);
      if (from < 0 || to < 0) throw new Error(`${row.id}: 없는 선행 범위 ${dep}`);
      return rows.slice(from, to + 1);
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

// 현재 관문(완료되지 않은 첫 관문)에서 담당별로 지금 할 수 있는 일을 고르고,
// 다음 관문들의 계획 대기 작업을 따로 모은다 (계획은 선행과 상관없이 미리 쓸 수 있다).
export function nextActions(rows, { hasPlan = () => true } = {}) {
  const current = rows.find((r) => r.stage !== '완료')?.milestone ?? null;
  const ready = {};
  const blocked = [];
  if (current === null) return { milestone: null, ready, blocked, ahead: [] };

  for (const row of rows.filter((r) => r.milestone === current && r.stage !== '완료')) {
    const waitingOn = resolveDeps(row, rows).filter((d) => d.stage !== '완료');
    let who;
    let what;
    if (needsPlan(row, hasPlan)) {
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
  const ahead = rows.filter((r) => r.milestone > current && needsPlan(r, hasPlan));
  return { milestone: current, ready, blocked, ahead };
}

export function render({ milestone, ready, blocked, ahead = [] }) {
  if (milestone === null) return '모든 작업이 완료됐습니다.';
  const lines = [
    `다음 작업 · 현재 관문 M${milestone} · 기준: docs/product/phases.md`,
    '흐름: 계획(Claude) → 구현 대기 → 진행중(담당) → 리뷰(구현하지 않은 쪽)',
    '',
  ];
  for (const who of ['Codex', 'Claude', '사용자']) {
    const items = ready[who] ?? [];
    const label = `[${who}]`;
    if (items.length === 0) {
      lines.push(`${label} 할 일 없음`);
      continue;
    }
    const [first, ...rest] = items;
    const handoff = first.what.startsWith('계획')
      ? ` · 구현은 ${first.row.owner}`
      : ['구현', '진행중'].includes(first.what) && first.row.owner !== '사용자'
        ? ` · 리뷰는 ${REVIEWER[first.row.owner]}`
        : '';
    lines.push(`${label} ${first.what} ${first.row.id} ${first.row.title} (AC-${first.row.ac})${handoff}`);
    if (rest.length > 0) {
      const shown = rest
        .slice(0, 5)
        .map((i) => `${i.row.id} ${i.what}`)
        .join(', ');
      lines.push(`    그 밖에 ${rest.length}건: ${shown}${rest.length > 5 ? ' …' : ''}`);
    }
  }
  const planning = [...(ready.Claude ?? []).filter((i) => i.what.startsWith('계획')).map((i) => i.row), ...ahead];
  lines.push('', `[계획] 구현 전 계획이 필요한 작업 ${planning.length}건 (Claude)`);
  if (planning.length === 0) {
    lines.push('    없음');
  } else {
    const byMilestone = new Map();
    for (const row of planning) byMilestone.set(row.milestone, [...(byMilestone.get(row.milestone) ?? []), row]);
    for (const [m, list] of byMilestone) {
      const shown = list
        .slice(0, 4)
        .map((r) => `${r.id} ${r.title.split(':')[0]}(구현 ${r.owner})`)
        .join(', ');
      lines.push(
        `    M${m}${m === milestone ? ' (현재)' : ''} ${list.length}건: ${shown}${list.length > 4 ? ' …' : ''}`,
      );
    }
  }
  if (blocked.length > 0) {
    const shown = blocked
      .slice(0, 5)
      .map((b) => `${b.row.id}(${b.who} ${b.what} ← ${b.waitingOn.map((d) => d.id).join('·')})`);
    lines.push('', `선행 대기 ${blocked.length}건: ${shown.join(', ')}${blocked.length > 5 ? ' …' : ''}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const markdown = readFileSync(new URL('../docs/product/phases.md', import.meta.url), 'utf8');
  const hasPlan = (id) => existsSync(new URL(`../docs/plans/${id}.md`, import.meta.url));
  console.log(render(nextActions(parseQueue(markdown), { hasPlan })));
}
