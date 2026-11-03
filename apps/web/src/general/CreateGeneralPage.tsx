import type { AppRouter } from '@opensamguk/server/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Portrait } from '../portrait/Portrait';
import { useTRPC } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState } from '../ui/States';
import {
  checkCreation,
  PORTRAIT_CHOICES,
  STATS,
  FIVE_STATS,
  FIVE_STAT_PRESETS,
  type CreationRules,
  type StatKey,
  type StatValues,
} from './createForm';
import styles from './CreateGeneralPage.module.css';
import {
  checkHeritage,
  HERITAGE_INSUFFICIENT_MESSAGE,
  withBonus,
  type HeritageBonus,
  type HeritageRules,
} from './heritage';
import { HeritageAllocation } from './HeritageAllocation';
import { stepStat, summarizeStats } from './statSummary';

const EVEN: StatValues = { leadership: '55', strength: '55', intel: '55', politics: '55', charm: '55' };

interface Draft {
  name: string;
  stats: StatValues;
  portraitId: number | null;
  // 가문 월드에서만 보내는 성별. 기본 선택이 없어 고르기 전에는 ''이다.
  sex: '' | 'MALE' | 'FEMALE';
  // 유산 월드에서만 쓰는 능력치별 유산 배분. 0인 능력치는 키가 없다.
  bonus: HeritageBonus;
  // 유산 월드에서 이 입력을 시작한 계정(creationRules.heritage.userId). 보낼 때 expectedUserId로 쓴다. 다른 월드는 null이다.
  owner: string | null;
}

type HeritageState = 'ok' | 'stale' | 'refreshed';
type Mine = inferRouterOutputs<AppRouter>['general']['mine'];

const EMPTY_DRAFT: Draft = { name: '', stats: EVEN, portraitId: null, sex: '', bonus: {}, owner: null };
const SEX_REQUIRED = '성별을 선택하세요.';

// 유산 월드에서 서버가 알려 준 현재 세션 계정. 다른 월드는 null이다.
const heritageOwner = (data: Mine | undefined) =>
  data && 'heritage' in data.creationRules ? data.creationRules.heritage.userId : null;

// /w/:worldId/create. 이름·통솔·무력·지력·초상으로 이 월드의 내 장수를 만든다 (AC-M1-06).
// 월드가 바뀌면 입력과 대기 상태를 처음부터 다시 잡는다.
export function CreateGeneralPage() {
  const { worldId } = useParams({ from: '/w/$worldId' });
  return <CreateGeneral key={worldId} worldId={worldId} />;
}

// 화면 상태는 general.mine 하나로 정한다. 장수가 있으면 안내, 요청이 pending이면 기다림, 그 밖(거절·처음)은 입력 폼이다.
// 서버가 5초 안에 결과를 못 주면 pending이 온다. 그때 general.mine 캐시를 pending으로 두고 1.5초마다 다시 묻는다.
// 엔진이 거절하면 general.mine이 rejected가 되어 새로고침 없이 거절 이유와 보낸 입력이 남은 폼으로 돌아온다.
function CreateGeneral({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // 이 화면에서 보낸 요청이나 대기하던 요청이 만들어지면 메인으로 간다. 처음부터 장수가 있으면 안내만 한다.
  const [creationStarted, setCreationStarted] = useState(false);
  const mineKey = trpc.general.mine.queryKey({ worldId });

  const mine = useQuery({
    ...trpc.general.mine.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (query.state.data?.creation?.status === 'pending' ? 1500 : false),
  });
  const general = mine.data?.general ?? null;
  const pending = mine.data?.creation?.status === 'pending';
  // 잔액 부족으로 거절되면 사용자가 「잔액 다시 확인」을 누를 때까지 제출을 막는다. 배분과 입력은 그대로 두고 다시 보내지 않는다.
  const [heritageState, setHeritageState] = useState<HeritageState>('ok');
  const rejectedCode = mine.data?.creation?.status === 'rejected' ? mine.data.creation.code : null;
  const lastRejected = useRef(rejectedCode);
  const owner = heritageOwner(mine.data);
  // 유산 월드의 입력은 처음 받은 계정에 묶는다. 다시 읽은 계정이 다르면 그 입력을 다음 계정에 옮기지 않고 그리기 전에 버린다.
  // 버린 뒤에는 새 계정의 빈 입력으로 다시 시작하며 아무것도 보내지 않는다.
  const [accountChanged, setAccountChanged] = useState(false);
  if (owner !== null && draft.owner !== owner) {
    if (draft.owner !== null) setAccountChanged(true);
    setDraft({ ...EMPTY_DRAFT, owner });
    setHeritageState('ok');
    setCreationStarted(false);
  }
  const accountNotice = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (accountChanged) accountNotice.current?.focus();
  }, [accountChanged, draft.owner]);

  useEffect(() => {
    if (pending) setCreationStarted(true);
  }, [pending]);

  // 이 화면에서 보낸 요청이 대기 뒤 잔액 부족으로 거절된 순간만 본다. 들어올 때 이미 있던 거절은 새 잔액을 받았으므로 막지 않는다.
  useEffect(() => {
    if (creationStarted && rejectedCode !== lastRejected.current && rejectedCode === 'HERITAGE_INSUFFICIENT')
      setHeritageState('stale');
    lastRejected.current = rejectedCode;
  }, [creationStarted, rejectedCode]);

  // 만들어지면 메인으로 간다. 메인과 위쪽 띠가 새 장수를 보도록 조회를 새로 받는다.
  useEffect(() => {
    if (!general || !creationStarted) return;
    void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
    void navigate({ to: '/w/$worldId', params: { worldId } });
  }, [general, creationStarted, navigate, queryClient, trpc, worldId]);

  let body;
  if (mine.isError) {
    const code = errorCode(mine.error);
    body =
      code === 'UNAUTHORIZED' ? (
        <Relogin worldId={worldId} />
      ) : code === 'NOT_FOUND' || code === 'BAD_REQUEST' ? (
        <EmptyState title="월드를 찾을 수 없습니다" />
      ) : (
        <ErrorState title="불러오지 못했습니다" onRetry={() => void mine.refetch()} />
      );
  } else if (!mine.data) {
    body = <p className={styles.muted}>불러오는 중…</p>;
  } else if (general) {
    body = (
      <div className={styles.done} role={creationStarted ? 'status' : undefined}>
        <Portrait id={general.portraitId} name={general.name} variant="icon" />
        <div>
          <p>
            이 월드의 내 장수는 <strong>{general.name}</strong>입니다. 한 월드에는 장수를 하나만 만들 수 있습니다.
          </p>
          <Link to="/w/$worldId" params={{ worldId }}>
            메인으로
          </Link>
        </div>
      </div>
    );
  } else if (pending) {
    body = (
      <p className={styles.pending} role="status">
        장수를 만드는 중…
      </p>
    );
  } else {
    body = (
      <>
        {accountChanged ? (
          <p ref={accountNotice} className={styles.alert} role="alert" tabIndex={-1}>
            계정이 바뀌어 이전 계정에서 넣은 입력과 유산 배분을 지웠습니다. 현재 계정으로 다시 입력하세요.
          </p>
        ) : null}
        {/* 계정이 바뀌면 폼을 새로 그려 이전 계정의 요청 상태·오류·알림이 남지 않게 한다. */}
        <CreateForm
          key={draft.owner ?? ''}
          worldId={worldId}
          rules={mine.data.creationRules}
          lineage={'lineageEnabled' in mine.data.creationRules && mine.data.creationRules.lineageEnabled === true}
          heritage={'heritage' in mine.data.creationRules ? mine.data.creationRules.heritage : undefined}
          currentOwner={owner}
          heritageState={heritageState}
          onHeritageShort={() => setHeritageState('stale')}
          onHeritageRefresh={() => {
            const pinned = draft.owner;
            void mine.refetch().then((result) => {
              // 다시 읽은 계정이 다르면 입력은 이미 버렸다. 새 입력에 「다시 확인했습니다」를 붙이지 않는다.
              if (!result.isError && heritageOwner(result.data) === pinned) setHeritageState('refreshed');
            });
          }}
          draft={draft}
          onDraft={setDraft}
          rejected={mine.data.creation?.status === 'rejected' ? mine.data.creation.message : null}
          onSubmitting={() => {
            setCreationStarted(true);
            setHeritageState((prev) => (prev === 'refreshed' ? 'ok' : prev));
          }}
          onPending={async () => {
            // 보내기 전에 시작한 조회가 늦게 와서 pending을 덮지 않게 멈춘다. 결과는 다시 묻기로 받는다.
            await queryClient.cancelQueries({ queryKey: mineKey });
            queryClient.setQueryData(mineKey, {
              general: null,
              creation: { status: 'pending' as const },
              creationRules: mine.data!.creationRules,
            });
          }}
          // 계정이 바뀌었다는 CONFLICT도 여기서 다시 읽는다. 새 계정이 오면 위에서 입력을 버리고 다시 보내지 않는다.
          onFailed={() => void queryClient.invalidateQueries({ queryKey: mineKey })}
          onCreated={(created) => {
            queryClient.setQueryData(mineKey, {
              general: created,
              creation: null,
              creationRules: mine.data!.creationRules,
            });
            void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
            void navigate({ to: '/w/$worldId', params: { worldId } });
          }}
        />
      </>
    );
  }

  return (
    <section className={styles.page}>
      <div className={styles.intro}>
        <span className={styles.plaque}>출사표</span>
        <h1>장수 생성</h1>
        <p className={styles.lead}>
          이름과 초상, 능력치를 정해 이 월드의 내 장수를 만듭니다. 한 월드에 장수는 하나입니다.
        </p>
      </div>
      {body}
    </section>
  );
}

function Relogin({ worldId }: { worldId: string }) {
  return (
    <div className={styles.alert} role="alert">
      <p>로그인이 풀렸습니다. 다시 로그인하세요.</p>
      <Link to="/login" search={{ next: `/w/${worldId}/create` }}>
        다시 로그인
      </Link>
    </div>
  );
}

type Created = NonNullable<inferRouterOutputs<AppRouter>['general']['mine']['general']>;

function CreateForm({
  worldId,
  rules,
  lineage,
  heritage,
  currentOwner,
  heritageState,
  onHeritageShort,
  onHeritageRefresh,
  draft,
  onDraft,
  rejected,
  onSubmitting,
  onPending,
  onFailed,
  onCreated,
}: {
  worldId: string;
  rules: CreationRules;
  // lineage-v1 월드면 성별을 꼭 고른다. 다른 월드에는 성별 칸이 없고 보내지도 않는다.
  lineage: boolean;
  // heritage-v1 월드에만 있다. 없으면 유산 첩도 heritage 키도 없다.
  heritage: HeritageRules | undefined;
  // 마지막으로 읽은 세션 계정. 입력을 묶은 draft.owner와 다르면 보내지 않는다.
  currentOwner: string | null;
  heritageState: HeritageState;
  onHeritageShort: () => void;
  onHeritageRefresh: () => void;
  draft: Draft;
  onDraft: (update: (prev: Draft) => Draft) => void;
  rejected: string | null;
  onSubmitting: () => void;
  onPending: () => Promise<void>;
  onFailed: () => void;
  onCreated: (general: Created) => void;
}) {
  const trpc = useTRPC();
  const create = useMutation(trpc.general.create.mutationOptions());
  // 입력은 화면(CreateGeneral)이 갖는다. 기다리는 동안 폼이 사라졌다가 거절로 돌아와도 보낸 값이 남는다.
  const { name, stats, portraitId, sex, bonus } = draft;
  const setName = (value: string) => onDraft((prev) => ({ ...prev, name: value }));
  const setStats = (update: (prev: StatValues) => StatValues) =>
    onDraft((prev) => ({ ...prev, stats: update(prev.stats) }));
  const setPortraitId = (value: number | null) => onDraft((prev) => ({ ...prev, portraitId: value }));
  const setSex = (value: 'MALE' | 'FEMALE') => onDraft((prev) => ({ ...prev, sex: value }));
  const setBonus = (key: StatKey, value: number) =>
    onDraft((prev) => {
      const next: HeritageBonus = { ...prev.bonus, [key]: value };
      if (value <= 0) delete next[key];
      return { ...prev, bonus: next };
    });
  const [touched, setTouched] = useState(false);
  const check = checkCreation(name, stats, rules);
  const heritageCheck = heritage ? checkHeritage(bonus, stats, rules, heritage, heritageState === 'stale') : null;
  const problems = [
    ...check.problems,
    ...(lineage && sex === '' ? [SEX_REQUIRED] : []),
    ...(heritageCheck?.problems ?? []),
  ];
  const problemsId = useId();
  const nameId = useId();
  const statId = useId();
  const sexHelpId = useId();
  // 유산 월드에서는 유산을 더한 최종 능력치로 요약한다. 보낼 능력치는 기본값 그대로다.
  const summary = summarizeStats(heritage ? withBonus(stats, bonus) : stats, rules);
  const spent = heritageCheck?.spent ?? 0;
  const submitLabel = spent > 0 ? `장수 만들기 (유산 ${spent}점 사용)` : '장수 만들기';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!check.stats || problems.length > 0 || create.isPending || draft.owner !== currentOwner) return;
    // 0인 능력치는 빼고 합이 0이면 heritage 키를 보내지 않는다. 보너스는 서버가 기본값에 더한다.
    const heritagePayload =
      heritageCheck && spent > 0
        ? {
            heritage: Object.fromEntries(
              heritageCheck.rows.filter((row) => row.bonus > 0).map((row) => [row.key, row.bonus]),
            ) as HeritageBonus,
          }
        : {};
    // 재조회가 생성 응답보다 빨라도 폼의 언마운트로 완료 전환을 잃지 않는다.
    onSubmitting();
    create.mutate(
      {
        worldId,
        name: check.name,
        ...check.stats,
        portraitId,
        ...(lineage && sex !== '' ? { sex } : {}),
        ...heritagePayload,
        // 유산 월드에서는 입력을 시작한 계정을 함께 보낸다. 세션이 바뀌었으면 서버가 입력·잔액을 건드리기 전에 거절한다.
        ...(heritage && draft.owner !== null ? { expectedUserId: draft.owner } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.status === 'created') onCreated(result.general);
          else void onPending();
        },
        // 연결이 끊겨 응답만 못 받았거나 다른 요청이 진행 중이면 서버에 pending이 남아 있을 수 있다. 상태를 다시 묻는다.
        onError: (failure) => {
          if (errorCode(failure) === 'CONFLICT' && serverMessage(failure) === HERITAGE_INSUFFICIENT_MESSAGE)
            onHeritageShort();
          onFailed();
        },
      },
    );
  };

  const error = create.error;
  const code = errorCode(error);
  const reason = problems[0] ?? null;

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {rejected && !create.error ? (
        <p className={styles.errorText} role="alert">
          지난 생성 요청이 거절되었습니다. {rejected}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={nameId}>이름</label>
        <input
          id={nameId}
          className={styles.input}
          value={name}
          maxLength={12}
          autoComplete="off"
          aria-invalid={touched && check.problems.some((p) => p.startsWith('이름'))}
          aria-describedby={problemsId}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <p className={styles.hint}>한글·한자·영문·숫자 1~6글자. 같은 월드에서 이미 쓰는 이름은 쓸 수 없습니다.</p>
      </div>

      <fieldset className={styles.stats} aria-describedby={problemsId}>
        <legend>
          능력치 (합계 {rules.total}, 각각 {rules.min}~{rules.max})
        </legend>
        {(rules.count === 5 ? FIVE_STATS : STATS).map((stat) => {
          // 숫자 칸이 기준이다. −/+는 칸 값을 한 칸씩 옮기기만 한다.
          const down = stepStat(stats[stat.key], -1, rules, check.remaining);
          const up = stepStat(stats[stat.key], 1, rules, check.remaining);
          const set = (value: string) => setStats((prev) => ({ ...prev, [stat.key as StatKey]: value }));
          return (
            <div key={stat.key} className={styles.stat}>
              <label htmlFor={`${statId}-${stat.key}`}>{stat.label}</label>
              <div className={styles.stepper}>
                <button
                  type="button"
                  className={styles.step}
                  aria-label={`${stat.label} 줄이기`}
                  disabled={down === null}
                  onClick={() => {
                    if (down !== null) set(down);
                  }}
                >
                  −
                </button>
                <input
                  id={`${statId}-${stat.key}`}
                  type="number"
                  inputMode="numeric"
                  className={`${styles.input} num`}
                  min={rules.min}
                  max={rules.max}
                  step={1}
                  value={stats[stat.key] ?? ''}
                  onChange={(e) => set(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.step}
                  aria-label={`${stat.label} 늘리기`}
                  disabled={up === null}
                  onClick={() => {
                    if (up !== null) set(up);
                  }}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
        <p className={styles.remaining} aria-live="polite" data-testid="remaining">
          남은 점수 <strong className="num">{check.remaining}</strong>
        </p>
        <button type="button" className={styles.secondary} onClick={() => setStats(() => EVEN)}>
          고르게 나누기
        </button>
        {rules.count === 5
          ? FIVE_STAT_PRESETS.map((preset) => (
              <button
                type="button"
                className={styles.secondary}
                key={preset.name}
                onClick={() =>
                  setStats(
                    () =>
                      Object.fromEntries(
                        FIVE_STATS.map((stat, index) => [stat.key, String(preset.values[index])]),
                      ) as StatValues,
                  )
                }
              >
                {preset.name}
              </button>
            ))
          : null}
      </fieldset>
      {rules.count === 5 ? (
        <p className={styles.hint}>
          통솔은 지휘 병력·피해 방어, 무력은 공격 피해, 지력은 연구·계략, 정치는 내정, 매력은 모병 비용·민심·NPC 서약에
          씁니다. 휘하 명망은 별도로 계산합니다.
        </p>
      ) : null}

      {heritage && heritageCheck ? (
        <HeritageAllocation
          heritage={heritage}
          rules={rules}
          result={heritageCheck}
          check={heritageState}
          onStep={setBonus}
          onRefresh={onHeritageRefresh}
        />
      ) : null}

      {lineage ? (
        <>
          {/* 초상 첩(.portraits)은 넓은 화면에서 왼쪽 칸 전체를 차지한다. 성별 첩은 같은 틀만 쓰고 오른쪽 칸에 둔다. */}
          <fieldset className={styles.sexGroup} aria-describedby={sexHelpId}>
            <legend>성별 (필수)</legend>
            {(
              [
                ['MALE', '남'],
                ['FEMALE', '여'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={styles.sexOption}>
                <input
                  type="radio"
                  name="sex"
                  value={value}
                  required
                  checked={sex === value}
                  onChange={() => setSex(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <p id={sexHelpId} className={styles.hint}>
            기본 선택이 없습니다. 이 월드는 가문 규칙을 써서 혼인과 출생이 남·여 짝만 됩니다. 성별은 만든 뒤 바꿀 수
            없습니다. 「미상」은 출처가 성별을 밝히지 않은 시나리오 인물에게만 붙으며 고를 수 없습니다.
          </p>
        </>
      ) : null}

      <fieldset className={styles.portraits}>
        <legend>초상</legend>
        <label className={styles.portraitOption}>
          <input type="radio" name="portrait" checked={portraitId === null} onChange={() => setPortraitId(null)} />
          <Portrait id={null} name={check.name || '장수'} variant="thumb" />
          <span>기본 이미지</span>
        </label>
        {PORTRAIT_CHOICES.map((id, i) => (
          <label key={id} className={styles.portraitOption}>
            <input type="radio" name="portrait" checked={portraitId === id} onChange={() => setPortraitId(id)} />
            <Portrait id={id} name={`초상 ${i + 1}`} variant="thumb" />
            <span>초상 {i + 1}</span>
          </label>
        ))}
      </fieldset>

      <div id={problemsId} className={styles.problems} aria-live="polite">
        {problems.length > 0 ? (
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? (
        <div className={styles.errorText} role="alert">
          {code === 'UNAUTHORIZED' ? (
            <>
              로그인이 풀렸습니다.{' '}
              <Link to="/login" search={{ next: `/w/${worldId}/create` }}>
                다시 로그인
              </Link>
            </>
          ) : (
            (serverMessage(error) ?? '생성 요청을 보내지 못했습니다. 연결을 확인하고 다시 누르세요.')
          )}
        </div>
      ) : null}

      <aside className={styles.summary} aria-labelledby={`${statId}-summary`}>
        <span id={`${statId}-summary`} className={styles.plaque}>
          이 장수는
        </span>
        {summary ? (
          <>
            <p>{summary.strong}</p>
            {summary.caution ? <p className={styles.muted}>{summary.caution}</p> : null}
            {spent > 0 ? <p className={styles.muted}>유산을 더한 최종 능력치로 봅니다.</p> : null}
          </>
        ) : (
          <p className={styles.muted}>능력치를 모두 정수로 넣으면 이 장수의 강점을 보입니다.</p>
        )}
      </aside>

      <div className={styles.actions}>
        {create.isPending ? (
          <button type="submit" className={styles.submit} disabled>
            만드는 중…
          </button>
        ) : reason ? (
          <DisabledReason reason={reason}>{submitLabel}</DisabledReason>
        ) : (
          <button type="submit" className={styles.submit}>
            {submitLabel}
          </button>
        )}
      </div>
    </form>
  );
}
