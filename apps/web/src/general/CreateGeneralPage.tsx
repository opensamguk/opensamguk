import type { AppRouter } from '@opensamguk/server/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
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

const EVEN: StatValues = { leadership: '55', strength: '55', intel: '55', politics: '55', charm: '55' };

interface Draft {
  name: string;
  stats: StatValues;
  portraitId: number | null;
}

const EMPTY_DRAFT: Draft = { name: '', stats: EVEN, portraitId: null };

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

  useEffect(() => {
    if (pending) setCreationStarted(true);
  }, [pending]);

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
      <CreateForm
        worldId={worldId}
        rules={mine.data.creationRules}
        draft={draft}
        onDraft={setDraft}
        rejected={mine.data.creation?.status === 'rejected' ? mine.data.creation.message : null}
        onSubmitting={() => setCreationStarted(true)}
        onPending={async () => {
          // 보내기 전에 시작한 조회가 늦게 와서 pending을 덮지 않게 멈춘다. 결과는 다시 묻기로 받는다.
          await queryClient.cancelQueries({ queryKey: mineKey });
          queryClient.setQueryData(mineKey, {
            general: null,
            creation: { status: 'pending' as const },
            creationRules: mine.data!.creationRules,
          });
        }}
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
    );
  }

  return (
    <section className={styles.page}>
      <h1>장수 생성</h1>
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
  const { name, stats, portraitId } = draft;
  const setName = (value: string) => onDraft((prev) => ({ ...prev, name: value }));
  const setStats = (update: (prev: StatValues) => StatValues) =>
    onDraft((prev) => ({ ...prev, stats: update(prev.stats) }));
  const setPortraitId = (value: number | null) => onDraft((prev) => ({ ...prev, portraitId: value }));
  const [touched, setTouched] = useState(false);
  const check = checkCreation(name, stats, rules);
  const problemsId = useId();
  const nameId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!check.stats || check.problems.length > 0 || create.isPending) return;
    // 재조회가 생성 응답보다 빨라도 폼의 언마운트로 완료 전환을 잃지 않는다.
    onSubmitting();
    create.mutate(
      { worldId, name: check.name, ...check.stats, portraitId },
      {
        onSuccess: (result) => {
          if (result.status === 'created') onCreated(result.general);
          else void onPending();
        },
        // 연결이 끊겨 응답만 못 받았거나 다른 요청이 진행 중이면 서버에 pending이 남아 있을 수 있다. 상태를 다시 묻는다.
        onError: onFailed,
      },
    );
  };

  const error = create.error;
  const code = errorCode(error);
  const reason = check.problems[0] ?? null;

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
        {(rules.count === 5 ? FIVE_STATS : STATS).map((stat) => (
          <label key={stat.key} className={styles.stat}>
            <span>{stat.label}</span>
            <input
              type="number"
              inputMode="numeric"
              className={`${styles.input} num`}
              min={rules.min}
              max={rules.max}
              step={1}
              value={stats[stat.key] ?? ''}
              onChange={(e) => setStats((prev) => ({ ...prev, [stat.key as StatKey]: e.target.value }))}
            />
          </label>
        ))}
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
        {check.problems.length > 0 ? (
          <ul>
            {check.problems.map((problem) => (
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

      <div className={styles.actions}>
        {create.isPending ? (
          <button type="submit" className={styles.submit} disabled>
            만드는 중…
          </button>
        ) : reason ? (
          <DisabledReason reason={reason}>장수 만들기</DisabledReason>
        ) : (
          <button type="submit" className={styles.submit}>
            장수 만들기
          </button>
        )}
      </div>
    </form>
  );
}
