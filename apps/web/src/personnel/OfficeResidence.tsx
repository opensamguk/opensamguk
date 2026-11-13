import { useId, useRef, useState } from 'react';
import type { CityView } from '../game/types';
import { DisabledReason } from '../ui/DisabledReason';
import type { PersonnelBoard, PersonnelMember } from './contract';
import styles from './Personnel.module.css';

const LOCAL_OFFICES = [
  { level: 4, title: '태수' },
  { level: 3, title: '군사' },
  { level: 2, title: '종사' },
] as const;
const presence = (resident: boolean) => (resident ? '주재' : '부재');

export function cityOfficeHolder(members: PersonnelMember[], cityKey: number, officerLevel: number) {
  return members.find((member) => member.officerLevel === officerLevel && member.officerCityKey === cityKey);
}

export function CityOfficeResidences({
  officers,
  secretaryEnabled,
}: {
  officers: NonNullable<CityView['officers']>;
  secretaryEnabled?: boolean;
}) {
  const titleId = useId();
  return (
    <section className={styles.cityOffices} aria-labelledby={titleId}>
      <h3 id={titleId}>관직 주재</h3>
      <ul>
        {LOCAL_OFFICES.filter(({ level }) => level !== 2 || secretaryEnabled).map(({ level, title }) => {
          const holder = officers.find((officer) => officer.officerLevel === level);
          return (
            <li key={level}>
              {title} {holder ? `${holder.name} · ${presence(holder.resident)}` : '없음'}
            </li>
          );
        })}
        {officers
          .filter(({ officerLevel }) => officerLevel >= 5 && officerLevel <= 11)
          .map((officer) => (
            <li key={officer.generalId}>
              {officer.officerLevel === 11 ? '참모' : '수뇌'} {officer.name} · {presence(officer.resident)}
            </li>
          ))}
      </ul>
    </section>
  );
}

export function MemberResidence({
  member,
  cities,
}: {
  member: PersonnelMember;
  cities: NonNullable<PersonnelBoard['officeCities']>;
}) {
  const assignment = cities.find(({ cityKey }) => cityKey === member.officerCityKey);
  if (assignment)
    return (
      <span className={styles.residence}>
        현재 {member.city.name}
        <span>
          담당 {assignment.name} · {presence(member.resident === true)}
        </span>
      </span>
    );
  if (member.officerLevel >= 5 && member.officerLevel <= 11)
    return (
      <span>
        현재 {member.city.name} · {presence(member.resident === true)}
      </span>
    );
  return member.city.name;
}

interface LocalOfficesProps {
  board: PersonnelBoard;
  candidates: PersonnelMember[];
  busyTarget: string | null;
  busyLabel: string;
  onAppoint: (generalId: number, officerLevel: number, cityKey: number) => void;
  onDismiss: (generalId: number, officerLevel: number, cityKey: number) => void;
}

export const localOfficeTarget = (cityKey: number, officerLevel: number) => `city-${cityKey}-level-${officerLevel}`;

export function LocalOffices({ board, candidates, busyTarget, busyLabel, onAppoint, onDismiss }: LocalOfficesProps) {
  const [cityKey, setCityKey] = useState('');
  const city = board.officeCities?.find((item) => String(item.cityKey) === cityKey);
  const canManage = board.appoint.ok;
  const titleId = useId();
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId}>지방 관직</h2>
      {board.appoint.ok ? (
        <label className={styles.officeField}>
          담당 도시
          <select
            value={city?.cityKey ?? ''}
            onChange={(event) => setCityKey(event.target.value)}
            disabled={busyTarget !== null}
          >
            <option value="">고르세요</option>
            {board.officeCities?.map((item) => (
              <option key={item.cityKey} value={item.cityKey}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <DisabledReason reason={board.appoint.reason}>지방 관직 임명</DisabledReason>
      )}
      {canManage && !city ? <DisabledReason reason="담당 도시를 고르세요.">지방 관직 임명</DisabledReason> : null}
      {city && canManage ? (
        <div className={styles.localOffices}>
          {LOCAL_OFFICES.filter(({ level }) => level !== 2 || board.secretaryEnabled).map(({ level, title }) => {
            const holder = cityOfficeHolder(board.members, city.cityKey, level);
            return (
              <LocalOfficeSlot
                key={localOfficeTarget(city.cityKey, level) + '-' + holder?.generalId}
                title={title}
                cityName={city.name}
                holder={holder}
                candidates={candidates.filter((member) => member.eligibleLocalOffices?.includes(level) ?? true)}
                qualification={
                  board.localOfficeMinimum !== undefined && level !== 2
                    ? `직책이 없는 소속 장수 중 ${level === 4 ? '무력' : '지력'} ${board.localOfficeMinimum} 이상`
                    : '직책이 없는 소속 장수'
                }
                busy={busyTarget !== null}
                busyLabel={busyTarget === localOfficeTarget(city.cityKey, level) ? busyLabel : undefined}
                onAppoint={(generalId) => onAppoint(generalId, level, city.cityKey)}
                onDismiss={(generalId) => onDismiss(generalId, level, city.cityKey)}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function LocalOfficeSlot({
  title,
  cityName,
  holder,
  candidates,
  qualification,
  busy,
  busyLabel,
  onAppoint,
  onDismiss,
}: {
  title: string;
  cityName: string;
  holder: PersonnelMember | undefined;
  candidates: PersonnelMember[];
  qualification: string;
  busy: boolean;
  busyLabel: string | undefined;
  onAppoint: (generalId: number) => void;
  onDismiss: (generalId: number) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [confirm, setConfirm] = useState(false);
  const appointButton = useRef<HTMLButtonElement>(null);
  const candidate = candidates.find(({ generalId }) => String(generalId) === chosen);
  const replacing = confirm && candidate && holder;
  return (
    <fieldset className={styles.officeSlot} disabled={busy}>
      <legend>{title}</legend>
      <p className={styles.officeNote}>
        {holder ? `${holder.name} · ${presence(holder.resident === true)}` : '빈 자리'}
      </p>
      <p className={styles.officeNote}>{qualification}</p>
      <label className={styles.officeField}>
        임명할 장수
        <select
          value={candidate?.generalId ?? ''}
          onChange={(event) => {
            setChosen(event.target.value);
            setConfirm(false);
          }}
        >
          <option value="">고르세요</option>
          {candidates.map((member) => (
            <option key={member.generalId} value={member.generalId}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      {replacing ? (
        <p className={styles.officeNote} role="status">
          기존 담당자 {holder.name} 해임 후 {cityName} {title}에 {candidate.name} 임명
        </p>
      ) : null}
      <div className={styles.controls}>
        <button
          type="button"
          ref={appointButton}
          className={styles.primary}
          disabled={!candidate}
          onClick={() => {
            if (!candidate) return;
            if (holder && !confirm) setConfirm(true);
            else {
              setConfirm(false);
              onAppoint(candidate.generalId);
            }
          }}
        >
          {holder ? (confirm ? '교체 확인' : '교체 임명') : `${title} 임명`}
        </button>
        {replacing ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setConfirm(false);
              appointButton.current?.focus();
            }}
          >
            취소
          </button>
        ) : holder ? (
          <button
            type="button"
            className={`${styles.secondary} ${styles.danger}`}
            onClick={() => onDismiss(holder.generalId)}
          >
            {title} 해임
          </button>
        ) : null}
      </div>
      {busyLabel ? (
        <span className={styles.busy} role="status">
          {busyLabel}
        </span>
      ) : null}
    </fieldset>
  );
}
