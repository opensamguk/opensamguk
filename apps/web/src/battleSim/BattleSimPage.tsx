import { useId, useMemo, useState, type ReactNode } from 'react';
import { useHome, useWorldId, useWorldRules } from '../game/queries';
import { DisabledReason } from '../ui/DisabledReason';
import { ErrorState, LoadingState } from '../ui/States';
import { ValueDelta } from '../ui/ValueDelta';
import {
  checkForm,
  defaultForm,
  GENERAL_CREW_MAX,
  LIMITS,
  problemText,
  WALL_CREW_TYPE,
  WALL_STAT,
  type BattleForce,
  type BattleForm,
  type BattleRunBody,
  type BattleRunResult,
  type DefenderKind,
  type FieldProblem,
  type ForceForm,
} from './request';
import { worldUnits, type UnitInfo, type WorldUnitSet } from './unitChoices';
import { useBattleWorker, type BattleWorkerState } from './useBattleWorker';
import styles from './BattleSimPage.module.css';

// /w/:worldId/simulator. 보조 화면이다 (T4-34). 사용자가 넣은 가정으로 교전 한 번을 Web Worker에서 계산한다.
// 내 장수 가져오기는 게임 레이아웃과 같은 home.get 조회를 쓴다 (INT-26).
// 저장소(sessionStorage 등)를 읽거나 쓰지 않는다.

const ERROR_TEXT: Record<Exclude<BattleWorkerState, { status: 'idle' | 'running' | 'done' }>['code'], string> = {
  INVALID_INPUT: 'Worker가 입력을 받지 않았습니다.',
  UNIT_SET_INVALID: '병종표를 읽지 못했습니다.',
  FAILED: '계산하지 못했습니다.',
  WORKER: '계산 Worker를 실행하지 못했습니다.',
};

export function BattleSimPage() {
  const worldId = useWorldId();
  const rules = useWorldRules(worldId);
  return (
    <section className={styles.page} aria-labelledby="battle-sim-title">
      <h1 id="battle-sim-title">전투 시뮬레이터</h1>
      {rules.data ? (
        // 월드가 바뀌면 폼과 Worker를 새로 만든다. 앞 월드의 병종표가 남지 않는다.
        <BattleSimForm
          key={worldId}
          worldId={worldId}
          unitSetKey={rules.data.unitSetKey}
          unitSet={rules.data.unitSet}
          fiveStats={rules.data.statRules.count === 5}
        />
      ) : (
        <>
          {rules.isError ? (
            <ErrorState title="이 월드의 병종표를 불러오지 못했습니다" onRetry={() => void rules.refetch()} />
          ) : (
            <LoadingState>병종표를 불러오는 중</LoadingState>
          )}
          <Assumptions />
        </>
      )}
    </section>
  );
}

function BattleSimForm({
  worldId,
  unitSetKey,
  unitSet,
  fiveStats,
}: {
  worldId: string;
  unitSetKey: string;
  unitSet: WorldUnitSet;
  fiveStats: boolean;
}) {
  const home = useHome(worldId);
  const general = home.isError ? undefined : home.data?.general;
  const units = useMemo(() => worldUnits(unitSet), [unitSet]);
  // shortcut: 장수 병종이 없는 병종표면 0으로 두어 병종 칸 오류로 보인다. 실제 출병도 그런 표로는 돌지 않는다.
  const [form, setForm] = useState<BattleForm>(() => defaultForm(units.defaultId ?? 0));
  const { state, run, cancel, retry } = useBattleWorker(unitSet);
  const checked = useMemo(() => checkForm(form, units.all, true), [form, units]);
  const problems = useMemo(() => {
    const byField = new Map<string, FieldProblem>();
    for (const found of checked.problems) if (!byField.has(found.field)) byField.set(found.field, found);
    return byField;
  }, [checked]);

  const setForce = (side: 'attacker' | 'defender', key: keyof ForceForm, value: string) =>
    setForm((f) => ({ ...f, [side]: { ...f[side], [key]: value } }));
  const set = (key: 'wall' | 'defence' | 'attackerTech' | 'defenderTech' | 'seed', value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const wall = form.defenderKind === 'wall';
  const importAttacker = () => {
    if (!general) return;
    const nation = home.data?.nation;
    const battleHeritage = { ...general.heritageBenefits };
    delete battleHeritage.domesticSuccess;
    delete battleHeritage.domesticFailure;
    const traits = {
      ...(general.personalityEffects ? { personality: general.personalityEffects.name } : {}),
      ...(general.combatSpecialty ? { specialty: general.combatSpecialty.name } : {}),
      ...(general.battleTactics ? { tactics: general.battleTactics } : {}),
      ...(Object.keys(battleHeritage).length ? { heritage: battleHeritage } : {}),
      ...(general.proficiency?.length
        ? { proficiency: Object.fromEntries(general.proficiency.map(({ armType, value }) => [armType, value])) }
        : {}),
    };
    setForm((current) => ({
      ...current,
      statProfile: fiveStats ? 'five-stats' : 'legacy',
      attackerTraits: Object.keys(traits).length ? traits : undefined,
      attacker: {
        crew: String(general.crew),
        crewType: units.generals.some(({ id }) => id === general.crewType) ? String(general.crewType) : '',
        train: String(general.train),
        atmos: String(general.atmos),
      },
      attackerTech: String(nation && 'tech' in nation ? nation.tech : 0),
      attackerCommander: { leadership: String(general.leadership), strength: String(general.strength) },
    }));
  };

  return (
    <>
      <p className={styles.muted}>
        이 월드의 병종표({unitSetKey})로 교전 한 번을 계산합니다. 공격 칸에는 내 장수의 값을 가져올 수 있습니다.
      </p>

      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (checked.body) run(checked.body);
        }}
      >
        <label className={styles.field}>
          계산 규칙
          <select
            className={styles.input}
            value={form.statProfile}
            onChange={(event) =>
              setForm((current) => ({ ...current, statProfile: event.target.value as BattleForm['statProfile'] }))
            }
          >
            <option value="legacy">구형 월드, 지휘관 보정 없음</option>
            <option value="five-stats">통합판 5능력치, 지휘관 보정</option>
          </select>
        </label>
        <div className={styles.sides}>
          <fieldset className={styles.side}>
            <legend>공격</legend>
            {general ? (
              <button type="button" className={styles.primary} onClick={importAttacker}>
                내 장수 값 가져오기
              </button>
            ) : null}
            {form.attackerTraits ? (
              <div className={styles.row}>
                <span>
                  {[
                    form.attackerTraits.personality,
                    form.attackerTraits.specialty,
                    form.attackerTraits.proficiency && '병종 숙련',
                    form.attackerTraits.tactics && '전투계략',
                    form.attackerTraits.heritage && '유산 혜택',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setForm((current) => ({ ...current, attackerTraits: undefined }))}
                >
                  가져온 효과 빼기
                </button>
              </div>
            ) : null}
            <ForceFields
              side="attacker"
              form={form.attacker}
              units={units.generals}
              problems={problems}
              onChange={setForce}
            />
            {form.statProfile === 'five-stats' ? (
              <CommanderFields
                side="attacker"
                value={form.attackerCommander}
                problems={problems}
                onChange={(key, value) =>
                  setForm((current) => ({
                    ...current,
                    attackerCommander: { ...current.attackerCommander, [key]: value },
                  }))
                }
              />
            ) : null}
            <NumberField
              label="기술"
              field="attackerTech"
              value={form.attackerTech}
              problems={problems}
              hint={`0~${LIMITS.MAX_TECH.toLocaleString('ko-KR')}`}
              onChange={(v) => set('attackerTech', v)}
            />
          </fieldset>

          <fieldset className={styles.side}>
            <legend>수비</legend>
            <div className={styles.kind} role="radiogroup" aria-label="수비 종류">
              {(
                [
                  ['general', '장수'],
                  ['wall', '성벽'],
                ] as Array<[DefenderKind, string]>
              ).map(([kind, label]) =>
                kind === 'wall' && !units.hasWall ? (
                  // 병종표에 성벽이 없으면 실제 출병도 성벽 교전을 하지 않는다 (packages/rules/src/commands/attack.ts).
                  <DisabledReason key={kind} reason={`이 병종표에는 성벽(${WALL_CREW_TYPE})이 없습니다.`}>
                    {label}
                  </DisabledReason>
                ) : (
                  <label key={kind} className={styles.choice}>
                    <input
                      type="radio"
                      name="defender-kind"
                      value={kind}
                      checked={form.defenderKind === kind}
                      onChange={() => setForm((f) => ({ ...f, defenderKind: kind }))}
                    />
                    {label}
                  </label>
                ),
              )}
            </div>
            {wall ? (
              <>
                <p className={styles.fixed}>
                  병종 {units.name(WALL_CREW_TYPE) ?? WALL_CREW_TYPE}, 훈련 {WALL_STAT}, 사기 {WALL_STAT} (고정)
                </p>
                <NumberField
                  label="성벽"
                  field="defender.crew"
                  value={form.wall}
                  problems={problems}
                  hint={`1~${LIMITS.WALL_MAX.toLocaleString('ko-KR')}`}
                  onChange={(v) => set('wall', v)}
                />
                <NumberField
                  label="수비"
                  field="defence"
                  value={form.defence}
                  problems={problems}
                  hint={`0~${LIMITS.WALL_MAX.toLocaleString('ko-KR')}`}
                  onChange={(v) => set('defence', v)}
                />
              </>
            ) : (
              <ForceFields
                side="defender"
                form={form.defender}
                units={units.generals}
                problems={problems}
                onChange={setForce}
              />
            )}
            {form.statProfile === 'five-stats' && !wall ? (
              <CommanderFields
                side="defender"
                value={form.defenderCommander}
                problems={problems}
                onChange={(key, value) =>
                  setForm((current) => ({
                    ...current,
                    defenderCommander: { ...current.defenderCommander, [key]: value },
                  }))
                }
              />
            ) : null}
            <NumberField
              label="기술"
              field="defenderTech"
              value={form.defenderTech}
              problems={problems}
              hint={`0~${LIMITS.MAX_TECH.toLocaleString('ko-KR')}`}
              onChange={(v) => set('defenderTech', v)}
            />
          </fieldset>
        </div>

        <TextField label="시드" field="seed" problems={problems} hint={`1~${LIMITS.SEED_MAX}자`}>
          {(props) => (
            <input
              {...props}
              className={styles.input}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.seed}
              onChange={(e) => set('seed', e.target.value)}
            />
          )}
        </TextField>

        <div className={styles.actions}>
          {checked.body ? (
            <button type="submit" className={styles.primary}>
              실행
            </button>
          ) : (
            <DisabledReason reason="표시한 칸을 고치면 실행할 수 있습니다.">실행</DisabledReason>
          )}
        </div>
      </form>

      <Assumptions />
      <ResultPanel state={state} current={checked.body} unitName={units.name} onCancel={cancel} onRetry={retry} />
    </>
  );
}

type Problems = ReadonlyMap<string, FieldProblem>;

function CommanderFields({
  side,
  value,
  problems,
  onChange,
}: {
  side: 'attacker' | 'defender';
  value: { leadership: string; strength: string };
  problems: Problems;
  onChange: (key: 'leadership' | 'strength', value: string) => void;
}) {
  return (
    <>
      {(['leadership', 'strength'] as const).map((key) => (
        <NumberField
          key={key}
          label={key === 'leadership' ? '지휘관 통솔' : '지휘관 무력'}
          field={`commanders.${side}.${key}`}
          value={value[key]}
          problems={problems}
          hint="0~100, 가정한 실제 지휘관 값"
          onChange={(next) => onChange(key, next)}
        />
      ))}
    </>
  );
}

function ForceFields({
  side,
  form,
  units,
  problems,
  onChange,
}: {
  side: 'attacker' | 'defender';
  form: ForceForm;
  units: readonly UnitInfo[];
  problems: Problems;
  onChange: (side: 'attacker' | 'defender', key: keyof ForceForm, value: string) => void;
}) {
  return (
    <>
      <TextField label="병종" field={`${side}.crewType`} problems={problems}>
        {(props) => (
          <select
            {...props}
            className={styles.input}
            value={form.crewType}
            onChange={(e) => onChange(side, 'crewType', e.target.value)}
          >
            {units.map((unit) => (
              <option key={unit.id} value={String(unit.id)}>
                {unit.name}
              </option>
            ))}
          </select>
        )}
      </TextField>
      <NumberField
        label="병력"
        field={`${side}.crew`}
        value={form.crew}
        problems={problems}
        hint={`1~${GENERAL_CREW_MAX.toLocaleString('ko-KR')}`}
        onChange={(v) => onChange(side, 'crew', v)}
      />
      <NumberField
        label="훈련"
        field={`${side}.train`}
        value={form.train}
        problems={problems}
        hint={`0~${LIMITS.STAT_MAX}`}
        onChange={(v) => onChange(side, 'train', v)}
      />
      <NumberField
        label="사기"
        field={`${side}.atmos`}
        value={form.atmos}
        problems={problems}
        hint={`0~${LIMITS.STAT_MAX}`}
        onChange={(v) => onChange(side, 'atmos', v)}
      />
    </>
  );
}

type FieldProps = { id: string; name: string; 'aria-invalid': boolean; 'aria-describedby': string };

function TextField({
  label,
  field,
  problems,
  hint,
  children,
}: {
  label: string;
  field: string;
  problems: Problems;
  hint?: string;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const found = problems.get(field);
  return (
    <div className={styles.field} data-field={field}>
      <label htmlFor={id}>{label}</label>
      {children({ id, name: field, 'aria-invalid': Boolean(found), 'aria-describedby': `${id}-hint` })}
      <p id={`${id}-hint`} className={found ? styles.problem : styles.hint} data-problem={found ? 'true' : undefined}>
        {found ? problemText(found) : hint}
      </p>
    </div>
  );
}

function NumberField({
  label,
  field,
  value,
  problems,
  hint,
  onChange,
}: {
  label: string;
  field: string;
  value: string;
  problems: Problems;
  hint: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextField label={label} field={field} problems={problems} hint={hint}>
      {(props) => (
        <input
          {...props}
          className={`${styles.input} num`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </TextField>
  );
}

function Assumptions() {
  return (
    <div className={styles.assumptions} role="note" aria-label="계산 가정">
      <p>
        교전 한 번만 계산합니다. 출병 전 군량 소비와 굶주림에 따른 사기 감소, 수비 장수 여럿과 성벽으로 이어지는 교전,
        실제 턴의 난수 흐름은 넣지 않았습니다. 그래서 실제 턴의 전투 결과와 다를 수 있습니다.
      </p>
    </div>
  );
}

function sameBody(result: BattleRunResult, body: BattleRunBody | null): boolean {
  if (!body) return false;
  return JSON.stringify({ seed: result.seed, ...result.input }) === JSON.stringify(body);
}

function ResultPanel({
  state,
  current,
  unitName,
  onCancel,
  onRetry,
}: {
  state: BattleWorkerState;
  current: BattleRunBody | null;
  unitName: (id: number) => string | undefined;
  onCancel: () => void;
  onRetry: () => void;
}) {
  return (
    <section
      className={styles.result}
      aria-labelledby="battle-sim-result"
      aria-live="polite"
      data-testid="battle-result"
      data-state={state.status}
    >
      <h2 id="battle-sim-result">결과</h2>
      {state.status === 'idle' ? <p className={styles.muted}>아직 계산하지 않았습니다.</p> : null}
      {state.status === 'running' ? (
        <div className={styles.row}>
          <p role="status">계산 중</p>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            취소
          </button>
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className={styles.row} role="alert">
          <p>{ERROR_TEXT[state.code]}</p>
          <button type="button" className={styles.secondary} onClick={onRetry}>
            다시 실행
          </button>
        </div>
      ) : null}
      {state.status === 'done' ? (
        <>
          {!sameBody(state.result, current) ? (
            <p className={styles.stale} data-testid="result-stale">
              지금 입력과 다른 값으로 계산한 결과입니다.
            </p>
          ) : null}
          <dl className={styles.meta}>
            <dt>시드</dt>
            <dd data-testid="result-seed">{state.result.seed}</dd>
            <dt>병종표</dt>
            <dd data-testid="result-unitset">{state.result.unitSetId}</dd>
            <dt>지휘관 보정</dt>
            <dd data-testid="result-commanders">
              {state.result.input.commanders
                ? `공격 통솔 ${state.result.input.commanders.attacker.leadership}·무력 ${state.result.input.commanders.attacker.strength}, ${state.result.input.commanders.defender ? `수비 통솔 ${state.result.input.commanders.defender.leadership}·무력 ${state.result.input.commanders.defender.strength}` : '성벽 보정 없음'}`
                : '구형 월드, 보정 없음'}
            </dd>
          </dl>
          <div className={styles.forces}>
            <ForceResult
              title="공격"
              unitName={unitName}
              side="attacker"
              start={state.result.input.attacker}
              end={state.result.attacker}
              tech={state.result.input.attackerTech}
            />
            <ForceResult
              title="수비"
              unitName={unitName}
              side="defender"
              start={state.result.input.defender}
              end={state.result.defender}
              tech={state.result.input.defenderTech}
              defence={state.result.input.defence}
            />
          </div>
          {state.result.phases?.length ? (
            <details>
              <summary>교전 단계</summary>
              <ol>
                {state.result.phases.map((phase, index) => (
                  <li key={index}>
                    {{ volley: '선제 사격', hold: '저지', exchange: '교전' }[phase.kind]}
                    {' · '}공격군 손실 {phase.attackerLoss.toLocaleString('ko-KR')}
                    {' · '}수비군 손실 {phase.defenderLoss.toLocaleString('ko-KR')}
                    {phase.attackerEvaded ? ' · 공격 측 회피' : ''}
                    {phase.defenderEvaded ? ' · 수비 측 회피' : ''}
                    {phase.attackerCritical ? ' · 공격 측 필살' : ''}
                    {phase.defenderCritical ? ' · 수비 측 필살' : ''}
                    {phase.attackerTactic
                      ? ` · 공격 측 ${phase.attackerTactic.name} ${phase.attackerTactic.success ? '성공' : '실패'}`
                      : ''}
                    {phase.defenderTactic
                      ? ` · 수비 측 ${phase.defenderTactic.name} ${phase.defenderTactic.success ? '성공' : '실패'}`
                      : ''}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <div className={styles.row}>
            <button type="button" className={styles.secondary} onClick={onRetry}>
              같은 값으로 다시 실행
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ForceResult({
  title,
  unitName,
  side,
  start,
  end,
  tech,
  defence,
}: {
  title: string;
  unitName: (id: number) => string | undefined;
  side: 'attacker' | 'defender';
  start: BattleForce;
  end: BattleForce;
  tech: number;
  defence?: number | undefined;
}) {
  const wall = defence !== undefined;
  return (
    <div className={styles.force} data-testid={`result-${side}`}>
      <h3>
        {title} · {unitName(start.crewType) ?? `병종 ${start.crewType}`}
      </h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">시작</th>
            <th scope="col">남음</th>
            <th scope="col">변화</th>
          </tr>
        </thead>
        <tbody>
          <tr data-row="crew">
            <th scope="row">{wall ? '성벽' : '병력'}</th>
            <td className="num">{start.crew.toLocaleString('ko-KR')}</td>
            <td className="num" data-value={end.crew}>
              {end.crew.toLocaleString('ko-KR')}
            </td>
            <td>
              <ValueDelta value={end.crew - start.crew} />
            </td>
          </tr>
          <tr data-row="atmos">
            <th scope="row">사기</th>
            <td className="num">{start.atmos}</td>
            <td className="num" data-value={end.atmos}>
              {end.atmos}
            </td>
            <td>
              <ValueDelta value={end.atmos - start.atmos} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className={styles.muted}>
        훈련 <span className="num">{start.train}</span>
        {wall ? ' (고정)' : ''} · 기술 <span className="num">{tech.toLocaleString('ko-KR')}</span>
        {wall ? (
          <>
            {' '}
            · 수비 <span className="num">{defence.toLocaleString('ko-KR')}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}
