import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { cityLevelText } from '../main/infoView';
import styles from './CreateGeneralPage.module.css';

type Rules = NonNullable<inferRouterOutputs<AppRouter>['general']['mine']['creationRules']['heritageBirth']>;
type Selection = NonNullable<inferRouterInputs<AppRouter>['general']['create']['heritageBirth']>;

export function HeritageBirthFields({
  rules,
  value,
  onChange,
}: {
  rules: Rules;
  value: Selection;
  onChange: (next: Selection) => void;
}) {
  const points = (cost: number) => `${cost.toLocaleString('ko-KR')}점`;
  const specialty = rules.specialties.find(({ name }) => name === value.specialty);
  const choose = <Key extends keyof Selection>(key: Key, choice: Selection[Key]) => {
    const next = { ...value };
    if (choice === undefined) delete next[key];
    else next[key] = choice;
    onChange(next);
  };
  return (
    <fieldset className={styles.sexGroup}>
      <legend>유산으로 시작 조건 선택</legend>
      <label className={styles.field}>
        <span>시작 도시 · {points(rules.costs.cityKey)}</span>
        <select
          className={styles.input}
          value={value.cityKey ?? ''}
          onChange={(event) => choose('cityKey', event.target.value ? Number(event.target.value) : undefined)}
        >
          <option value="">무작위 도시</option>
          {rules.cities.map((city) => (
            <option key={city.cityKey} value={city.cityKey}>
              {[city.name, cityLevelText(city.level), city.regionName].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>턴 시간대 · {points(rules.costs.turnZone)}</span>
        <select
          className={styles.input}
          value={value.turnZone ?? ''}
          onChange={(event) => choose('turnZone', event.target.value ? Number(event.target.value) : undefined)}
        >
          <option value="">무작위 시간대</option>
          {Array.from({ length: rules.turnZones }, (_, zone) => (
            <option key={zone} value={zone}>
              턴 주기의 {zone + 1}번째 구간
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>전투 특기 · {points(rules.costs.specialty)}</span>
        <select
          className={styles.input}
          value={value.specialty ?? ''}
          onChange={(event) => choose('specialty', event.target.value || undefined)}
        >
          <option value="">선택 안 함</option>
          {rules.specialties.map(({ name }) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {specialty ? <p className={styles.hint}>{specialty.description}</p> : null}
    </fieldset>
  );
}
