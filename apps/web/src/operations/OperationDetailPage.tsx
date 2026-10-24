import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { QueryError } from '../game/QueryState';
import { useWorldId, useWorldMap } from '../game/queries';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import type { ArgNames } from '../turns/args';
import { formatTime } from '../turns/schedule';
import { TurnEditor } from '../turns/TurnEditor';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { AlignPanel } from './AlignPanel';
import { SORTIE_COMMAND_KEY, type MemberTimeline, type OperationDetail } from './contract';
import styles from './Operations.module.css';
import {
  beyondNote,
  cellFor,
  EMPTY_SLOT_TITLE,
  sameMonth,
  shortDate,
  slotLabel,
  VERDICT_VIEW,
  visibleMonths,
  type SlotLabel,
} from './timeline';

// 작전 상세: 참여 장수 × 월 타임라인과 내 예턴 맞추기 (T2-12, AC-M2-15).
export function OperationDetailPage({ operationId }: { operationId: string }) {
  const worldId = useWorldId();
  const trpc = useTRPC();
  const detail = useQuery({
    ...trpc.operation.get.queryOptions({ worldId, id: operationId }),
    refetchInterval: 15_000,
    retry: retryUnlessClientError,
  });

  let body;
  if (detail.data) body = <Detail worldId={worldId} op={detail.data} />;
  else if (detail.isError && errorCode(detail.error) === 'FORBIDDEN')
    body = (
      <EmptyState title="볼 수 없는 작전입니다">
        {serverMessage(detail.error) ?? '작전은 같은 국가의 참여 장수와 직책자만 봅니다.'}{' '}
        <Link to="/w/$worldId/operations" params={{ worldId }}>
          작전 목록으로
        </Link>
      </EmptyState>
    );
  else if (detail.isError)
    body = <QueryError error={detail.error} notFound="작전을 찾을 수 없습니다" onRetry={() => void detail.refetch()} />;
  else body = <LoadingState />;

  return (
    <section className={styles.page}>
      <p>
        <Link to="/w/$worldId/operations" params={{ worldId }}>
          작전 목록
        </Link>
      </p>
      {body}
    </section>
  );
}

function Detail({ worldId, op }: { worldId: string; op: OperationDetail }) {
  const map = useWorldMap(worldId);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const months = visibleMonths(op.months, op.targetDate, expanded);
  const hidden = op.months.length - months.length;
  const names: ArgNames = useMemo(() => {
    const cities = map.data?.cities ?? [];
    const nations = map.data?.nations ?? [];
    return {
      city: (key) => cities.find((c) => c.key === key)?.name,
      nation: (id) => nations.find((n) => n.id === id)?.name,
    };
  }, [map.data]);

  // 닫기는 작전 메타데이터만 바꾼다. 작전 경로만 다시 받고 예턴 캐시는 건드리지 않는다.
  const close = useMutation(
    trpc.operation.close.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.operation.pathKey() }),
    }),
  );

  return (
    <>
      <header className={styles.head}>
        <h1>
          작전 {op.target.cityName}{' '}
          {op.target.nation ? <NationBadge name={op.target.nation.name} color={op.target.nation.color} /> : null}
        </h1>
        <p className={styles.meta}>
          <span>
            목표 {formatYearMonth(op.targetDate)}
            {op.targetAt !== null ? ` (${formatTime(new Date(op.targetAt), new Date())})` : null}
          </span>
          <span className="num">
            기준 병력 {op.min.crew.toLocaleString('ko-KR')} · 훈련 {op.min.train} · 사기 {op.min.atmos}
          </span>
          <span>{op.status === 'OPEN' ? <Tag tone="accent">진행</Tag> : <Tag tone="muted">닫힘</Tag>}</span>
          <span className="num">
            준비 {op.ready} / 참여 {op.members}
          </span>
        </p>
      </header>

      <section aria-label="작전 타임라인" className={styles.timelineWrap}>
        <p className={styles.legend}>
          {Object.values(VERDICT_VIEW).map((v) => (
            <Tag key={v.text} tone={v.tone}>
              {v.icon} {v.text}
            </Tag>
          ))}
          <span className={styles.muted}>
            판정은 예턴만 본 예상입니다. 금·쌀, 병종, 경로, 교전 상태는 실행 때 다시 검사합니다.
          </span>
        </p>
        <table className={styles.timeline} data-testid="operation-timeline">
          <thead>
            <tr>
              <th scope="col">장수</th>
              <th scope="col">판정(예상)</th>
              {months.map((m) => (
                <th
                  key={shortDate(m)}
                  scope="col"
                  className={sameMonth(m, op.targetDate) ? styles.targetCol : undefined}
                  aria-label={sameMonth(m, op.targetDate) ? `${shortDate(m)} 목표` : undefined}
                >
                  {shortDate(m)}
                  {sameMonth(m, op.targetDate) ? <span className={styles.targetMark}> 목표</span> : null}
                </th>
              ))}
              <th scope="col">목표 밖</th>
            </tr>
          </thead>
          <tbody>
            {op.timeline.map((member) => (
              <MemberRow
                key={member.generalId}
                member={member}
                months={months}
                target={op.targetDate}
                min={op.min}
                names={names}
              />
            ))}
          </tbody>
        </table>
        {op.timeline.length === 0 ? <p className={styles.muted}>지금 국가에 남은 참여 장수가 없습니다.</p> : null}
        {hidden > 0 || expanded ? (
          <button type="button" className={styles.secondary} onClick={() => setExpanded((v) => !v)}>
            {expanded ? '앞의 달 접기' : `앞의 ${hidden}개월 더 보기`}
          </button>
        ) : null}
      </section>

      {op.canClose.ok ? (
        <div className={styles.buttons}>
          {closing ? (
            <>
              <span>작전을 닫으면 판정과 맞추기를 더 쓰지 않습니다.</span>
              <button type="button" className={styles.primary} onClick={() => close.mutate({ worldId, id: op.id })}>
                닫기 확정
              </button>
              <button type="button" className={styles.secondary} onClick={() => setClosing(false)}>
                취소
              </button>
            </>
          ) : (
            <button type="button" className={styles.secondary} onClick={() => setClosing(true)}>
              작전 닫기
            </button>
          )}
          {close.isError ? (
            <span role="alert" className={styles.warn}>
              {serverMessage(close.error) ?? '닫지 못했습니다.'}
            </span>
          ) : null}
        </div>
      ) : null}

      {op.canSuggest.ok ? (
        <section className={styles.mine} aria-label="내 예턴">
          <h2>내 예턴</h2>
          <TurnEditor
            worldId={worldId}
            selectedCityKey={null}
            renderTop={(draft) => <AlignPanel worldId={worldId} operationId={op.id} draft={draft} names={names} />}
          />
        </section>
      ) : (
        // 못 쓰는 단추는 숨기지 않고 서버가 준 이유를 보인다 (참여하지 않음, 닫힌 작전 등).
        <p className={styles.muted}>
          <DisabledReason reason={op.canSuggest.reason}>내 예턴을 작전에 맞추기</DisabledReason>
        </p>
      )}
    </>
  );
}

function CellText({ label }: { label: SlotLabel }) {
  if (label.kind !== 'empty') return <>{label.text}</>;
  return (
    <span className={styles.muted} title={EMPTY_SLOT_TITLE}>
      {label.text}
    </span>
  );
}

// 참여 장수 한 줄. 일반 참여자도 다른 참여자의 명령과 인자를 본다(U62-1). 비워 둔 칸의 방침 명령은 짐작하지 않는다.
export function MemberRow({
  member,
  months,
  target,
  min,
  names,
}: {
  member: MemberTimeline;
  months: OperationDetail['months'];
  target: OperationDetail['targetDate'];
  min: OperationDetail['min'];
  names: ArgNames;
}) {
  const verdict = VERDICT_VIEW[member.verdict];
  const late = beyondNote(member, months, names);
  // 열은 서버 months만큼이라 목표가 가까우면 뒤 칸이 열 밖이다. 같은 줄에서 서버 cells 전부를 순서대로 펼친다.
  const [allSlots, setAllSlots] = useState(false);
  const listId = useId();
  // 다음 턴 시각이 null이면(정지·시작 전·가속 등) 서버가 준 게임 연월만 적는다.
  const next = member.cells[0];
  const nextText = next ? (next.at !== null ? formatTime(new Date(next.at), new Date()) : shortDate(next.date)) : null;
  const short = (key: 'crew' | 'train' | 'atmos') => member.expected[key] < min[key];
  return (
    <tr
      className={member.isMe ? styles.me : undefined}
      data-general-id={member.generalId}
      data-verdict={member.verdict}
    >
      <th scope="row">
        {member.name}
        {member.isMe ? <span className={styles.muted}> (나)</span> : null}
        <span className={styles.sub}>
          {member.cityName}
          {nextText !== null ? ` · 다음 턴 ${nextText}` : null}
        </span>
        <button
          type="button"
          className={styles.slotToggle}
          aria-expanded={allSlots}
          aria-controls={allSlots ? listId : undefined}
          aria-label={`${member.name}의 예턴 ${member.cells.length}칸 ${allSlots ? '접기' : '모두 보기'}`}
          onClick={() => setAllSlots((v) => !v)}
        >
          {allSlots ? '칸 접기' : `${member.cells.length}칸 모두 보기`}
        </button>
        {allSlots ? (
          <ol id={listId} className={styles.allSlots} aria-label={`${member.name}의 예턴 ${member.cells.length}칸`}>
            {member.cells.map((cell) => {
              const label = slotLabel(cell.turn, names);
              return (
                <li key={cell.slot} data-slot={cell.slot + 1} data-kind={label.kind}>
                  <span className="num">{cell.slot + 1}번 칸</span>{' '}
                  <span className={`${styles.muted} num`}>{shortDate(cell.date)}</span> <CellText label={label} />
                </li>
              );
            })}
          </ol>
        ) : null}
      </th>
      <td>
        <Tag tone={verdict.tone}>
          {verdict.icon} {verdict.text}
        </Tag>
        <span className={`${styles.sub} num`}>
          예상 병력{' '}
          <span className={short('crew') ? styles.warn : undefined}>
            {member.expected.crew.toLocaleString('ko-KR')}
          </span>{' '}
          · 훈련 <span className={short('train') ? styles.warn : undefined}>{member.expected.train}</span> · 사기{' '}
          <span className={short('atmos') ? styles.warn : undefined}>{member.expected.atmos}</span>
        </span>
      </td>
      {months.map((m) => {
        const cell = cellFor(member, m);
        const isSortie = !!cell && !!member.sortie && cell.slot === member.sortie.slot;
        const label = cell ? slotLabel(cell.turn, names) : null;
        return (
          <td
            key={shortDate(m)}
            className={[
              sameMonth(m, target) ? styles.targetCol : '',
              isSortie ? styles.sortie : '',
              cell?.turn.commandKey === SORTIE_COMMAND_KEY && !isSortie ? styles.otherSortie : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={cell && cell.at !== null ? formatTime(new Date(cell.at), new Date()) : undefined}
            data-slot={cell ? cell.slot + 1 : undefined}
            data-kind={label?.kind}
          >
            {label === null ? null : <CellText label={label} />}
          </td>
        );
      })}
      <td className={member.beyondWindow ? styles.muted : late ? styles.warn : undefined}>{late ?? ''}</td>
    </tr>
  );
}
